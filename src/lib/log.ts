// 標準出力へのログ。Actions のログでそのまま読める形にする。

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

export const log = {
  info(msg: string, extra?: unknown): void {
    console.log(`${ts()} ${msg}${extra === undefined ? "" : " " + JSON.stringify(extra)}`);
  },
  warn(msg: string, extra?: unknown): void {
    console.warn(`${ts()} WARN ${msg}${extra === undefined ? "" : " " + JSON.stringify(extra)}`);
  },
  error(msg: string, err?: unknown): void {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : err === undefined ? "" : JSON.stringify(err);
    console.error(`${ts()} ERROR ${msg} ${detail}`);
  },
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
