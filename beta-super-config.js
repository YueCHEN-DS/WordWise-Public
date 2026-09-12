// Beta-only super-license verifier configuration.
//
// Stable source and stable builds are deliberately fail-closed. The beta
// build script temporarily replaces this module with a salted verifier hash;
// it never embeds the plaintext beta code. This file must not contain a
// usable beta code.
export const BETA_SUPER_CONFIG = Object.freeze({
  enabled: false,
  saltB64: '',
  verifierB64: '',
});

