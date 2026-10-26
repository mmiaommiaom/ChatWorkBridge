# Security

ChatWorkBridge connects local application sessions that may have access to files and tools. Keep its HTTP and debugging endpoints bound to loopback and retain the permission prompts in the connected applications.

For a suspected vulnerability, use the repository's **Security → Report a vulnerability** feature when available. If private reporting is unavailable, open an issue containing only a request for a private contact channel; do not publish exploit details, credentials, local profiles or private task data.

Preview builds are experimental. Independent profiles and path validation are not a Windows security sandbox. Existing-profile mode inherits that profile's permissions and remains separately subject to validation.

Release assets include SHA256SUMS. Code signing is not configured for the first preview; a checksum is an integrity check, not proof that an unsigned executable is trusted by your system. If execution is blocked, stop and verify the published source and artifact, or use an auditable source checkout. Do not disable security protections.
