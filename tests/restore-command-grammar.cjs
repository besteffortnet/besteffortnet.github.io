// 画面の文字列をシェルへ渡さず、許可した引数列だけを再構成する。
function restoreArgs(display, record) {
  if (!record || typeof record.version !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(record.version) ||
      typeof record.ref !== 'string' ||
      !/^(?:[0-9a-f]{40}|webui-apps-v[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+)$/.test(record.ref)) {
    throw new Error('unsupported version or ref');
  }
  const args = ['python3', 'tools/prepare-webui-restore.py', record.ref, '--repo', '.',
    '--worktree-path', `../webui-restore-${record.version}`, '--branch', `restore/webui-${record.version}`];
  if (typeof display !== 'string' || display !== args.join(' ')) {
    throw new Error('displayed restore command differs from the allowed grammar');
  }
  return args;
}

module.exports = {restoreArgs};
