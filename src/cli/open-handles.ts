import { execFileSync } from "node:child_process";

/**
 * 세션 파일을 `rename`으로 교체하기 전에, 이 프로세스 밖에서 그 파일을 쓰기
 * 모드로 열어 둔 프로세스가 없는지 확인한다.
 *
 * 교체는 새 inode를 만든다. 파일을 append로 열어 둔 프로세스의 핸들은 옛
 * inode에 묶여 있어, 교체 뒤에 쓴 레코드는 새 파일에 없고 수술은 성공(종료
 * 코드 0)으로 끝난다 — 조용한 유실이다(루트 CLAUDE.md "정확성 원칙"). 읽기
 * 전용으로 연 프로세스(백업 도구, `tail -f` 등)는 잃을 쓰기가 없으므로 막지
 * 않는다.
 *
 * 확인에 `lsof -F pa -- <파일>`을 쓴다. 보유자가 없으면 종료 코드 1에 빈
 * 출력이고, 있으면 프로세스마다 `p<PID>` 뒤에 접근 모드 `a`(r, w, u)가 온다.
 * `lsof`를 실행하지 못하거나 예상 밖 종료 코드면 보유자가 없다고 가정하지
 * 않고 중단한다. 확인 뒤에 새로 파일을 여는 프로세스는 막지 못한다. 쓸
 * 때만 파일을 여는 프로세스(관찰된 Claude Code 세션)는 이 확인에 걸리지
 * 않으며, 그 경우 남는 유실 경로는 파일을 읽은 시점과 `rename` 사이에 덧붙은
 * 줄이다.
 *
 * @param lsofCommand 시험이 `lsof` 부재를 재현하려고 바꾸는 실행 파일 이름.
 */
export function assertNoOtherOpenHandles(
  filePath: string,
  lsofCommand = "lsof",
): void {
  let stdout: string;
  try {
    stdout = execFileSync(lsofCommand, ["-F", "pa", "--", filePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & {
      status?: number | null;
      stdout?: string;
    };
    if (failure.status === 1 && (failure.stdout ?? "").trim() === "") {
      return; // 보유자 없음
    }
    if (failure.code === "ENOENT") {
      throw new Error(
        `lsof를 실행할 수 없어 다른 프로세스가 이 파일을 열고 있는지 확인하지 못했습니다. lsof를 설치하거나 PATH를 확인하세요: ${filePath}`,
      );
    }
    throw new Error(
      `lsof가 예상 밖으로 끝나(종료 코드 ${failure.status ?? failure.code}) 다른 프로세스가 이 파일을 열고 있는지 확인하지 못했습니다: ${filePath}`,
    );
  }

  const writers = writersIn(stdout).filter((pid) => pid !== process.pid);
  if (writers.length === 0) return;

  throw new Error(
    `다른 프로세스(PID ${writers.join(", ")})가 이 파일을 쓰기로 열고 있어 교체하면 그 프로세스가 이후에 쓰는 레코드가 사라집니다. 세션을 종료한 뒤 다시 실행하세요: ${filePath}`,
  );
}

/** `lsof -F pa` 출력에서 쓰기 모드(`w`, `u`)로 연 PID만 순서대로, 중복 없이 모은다. */
function writersIn(output: string): number[] {
  const writers: number[] = [];
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
    } else if (
      line.startsWith("a") &&
      (line[1] === "w" || line[1] === "u") &&
      pid !== undefined &&
      Number.isInteger(pid) &&
      !writers.includes(pid)
    ) {
      writers.push(pid);
    }
  }
  return writers;
}
