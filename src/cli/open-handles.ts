import { execFileSync } from "node:child_process";

/**
 * 세션 파일을 `rename`으로 교체하기 전에, 이 프로세스 밖에서 그 파일을 열어
 * 둔 프로세스가 없는지 확인한다.
 *
 * 교체는 새 inode를 만든다. 파일을 append로 열어 둔 프로세스의 핸들은 옛
 * inode에 묶여 있어, 교체 뒤에 쓴 레코드는 새 파일에 없고 수술은 성공(종료
 * 코드 0)으로 끝난다 — 조용한 유실이다(루트 CLAUDE.md "정확성 원칙").
 *
 * 확인에 `lsof -t -- <파일>`을 쓴다. 보유자가 없으면 종료 코드 1에 빈 출력,
 * 있으면 PID를 한 줄씩 낸다. `lsof`를 실행하지 못하거나 예상 밖 종료 코드면
 * 보유자가 없다고 가정하지 않고 중단한다. 확인 뒤에 새로 파일을 여는
 * 프로세스는 막지 못한다.
 *
 * @param lsofCommand 시험이 `lsof` 부재를 재현하려고 바꾸는 실행 파일 이름.
 */
export function assertNoOtherOpenHandles(
  filePath: string,
  lsofCommand = "lsof",
): void {
  let stdout: string;
  try {
    stdout = execFileSync(lsofCommand, ["-t", "--", filePath], {
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
    throw new Error(
      `다른 프로세스가 이 파일을 열고 있는지 확인하지 못했습니다 (lsof 실행 실패: ${failure.code ?? `종료 코드 ${failure.status}`}). 세션을 종료한 뒤 다시 실행하세요: ${filePath}`,
    );
  }

  const holders = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== String(process.pid));
  if (holders.length === 0) return;

  throw new Error(
    `다른 프로세스(PID ${holders.join(", ")})가 이 파일을 열고 있어 교체하면 그 프로세스가 이후에 쓰는 레코드가 사라집니다. 세션을 종료한 뒤 다시 실행하세요: ${filePath}`,
  );
}
