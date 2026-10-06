// Shared by the public desktop build and its read-only package inspection.
export const nativeFilters = Object.freeze([
  '!vocab-core/vocab_core.mac.node',
  '!vocab-core/vocab_core.win32.node',
  '!node_modules/@node-llama-cpp/mac-*/**',
  '!node_modules/@node-llama-cpp/win-*/**',
  '!node_modules/@node-llama-cpp/linux-*/**',
]);

const privateFilters = Object.freeze([
  '!docs/**', '!public-files.json', '!.git/**', '!.env', '!.env.*',
  '!**/.env', '!**/.env.*', '!**/*.pem', '!**/*.key', '!**/*.crt', '!**/*.age',
  '!online-trial/**', '!backups/**', '!runtime/**', '!private-assets/**',
  '!public-release/**', '!.worktrees/**', '!.codex/**',
  '!wordwise-gold/**', '!wordwise-gold-archive/**', '!research-paper-portfolio/**',
  '!evaluation/**', '!paid/**', '!commercial/**', '!release-private/**',
]);

export function packageFilePatterns(patterns, target) {
  if (!Array.isArray(patterns) || !['mac', 'win'].includes(target)) {
    throw new Error('Expected desktop file patterns and a mac or win target');
  }
  const excludedPlatform = target === 'mac' ? 'win' : 'mac';
  const excludedBinary = target === 'mac' ? 'win32' : 'mac';
  return [...new Set([
    ...patterns.filter(pattern => !nativeFilters.includes(pattern)),
    `!vocab-core/vocab_core.${excludedBinary}.node`,
    `!node_modules/@node-llama-cpp/${excludedPlatform}-*/**`,
    '!node_modules/@node-llama-cpp/linux-*/**',
    ...privateFilters,
  ])];
}
