// 未実装の骨子。argv dispatch・JSON file読取・stdout/stderr境界・終了コードを実装する。
export async function runCli(_argv: string[], _env: NodeJS.ProcessEnv = process.env): Promise<number> {
  process.stderr.write('admin: internal_error\n');
  return 1;
}
