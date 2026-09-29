# Archive encryption (CR-08) — key management

Retention archives (`./data/archive/<ref>.json.enc`) hold full case PII and
are encrypted with AES-256-GCM. This file is the operator contract for the
key. Read it before generating, moving, or rotating anything.

## The key

- **Variable:** `ARCHIVE_KEY` — 32 bytes, written as 64 hex characters.
- **Generate:** `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  (or `openssl rand -hex 32`). Use a fresh random value per deployment —
  never reuse the test vector from `test/archive-encryption.test.ts`.
- **Lives in:** the deployed `.env` (loaded via dotenv) or the process
  environment. It deliberately lives **outside the database**: the settings
  table is plaintext, so storing the key there would add nothing.

## Rules

1. **Never commit the key.** Not in `.env`, not in docs, not in chat logs.
   `.env` stays git-ignored; `.env.example` carries only a placeholder.
2. **Lock the file:** `chmod 600 .env`, owned by the service user.
3. **Back the key up separately from the data.** The archives are
   unrecoverable without it — a backup of `./data` without the key is a
   backup of noise. Store one copy with your other deployment secrets
   (password manager / sealed envelope, whichever you already trust).
   Production escrow: a secure note in 1Password/Bitwarden (manual copy,
   separate from the deployed `.env`); the note must link back to this
   doc's Rotation section. No automated escrow — the manual copy is enough.
4. **Need-to-know:** the retain runner and whoever performs audits
   (`npm run archive:read`). Nobody else.
5. **Losing the key = losing the archives.** There is no recovery path and
   no escrow. This is the point of the encryption — treat the key like the
   PII it protects.

## Rotation

v1 has no automatic rotation (the envelope carries `v: 1` for future
algorithms). To rotate manually:

1. Decrypt everything with the old key to a scratch dir (loop
   `npm run archive:read`, or keep the `.json.enc` files — they decrypt
   with the old key only).
2. Set the new `ARCHIVE_KEY`.
3. Re-encrypt: place the plaintext records as `<ref>.json` in a scratch
   archive dir and run `npm run archive:encrypt` against it, then move the
   `.json.enc` files into place and shred the scratch plaintext.
4. Verify: `archive:read` a sample with the new key, then destroy the old key.

## What is (and is not) covered

- Covered: retention archives written by `npm run retain`, plus legacy
  plaintext archives migrated by `npm run archive:encrypt` (which deletes
  the original only after a decrypt-and-byte-compare round-trip check).
- NOT covered: live database, `./backups/*.sqlite` (separate concern —
  same treatment proposed as follow-up), logs, Gmail drafts.
- Refusal behaviour: `retain`, `archive:encrypt` and `archive:read` exit 2
  with a loud message when `ARCHIVE_KEY` is missing or malformed. There is
  no silent plaintext fallback — a missing key stops the run, not the
  encryption.
