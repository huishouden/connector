/**
 * The household's Firestore rules for the emulator, from huishouden/rules (the only deployer):
 * RULES_FILE (a local checkout's firestore.rules) or RULES_REF (default main) on GitHub.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const out = 'test/.rules/firestore.rules';
mkdirSync('test/.rules', { recursive: true });
const local = process.env.RULES_FILE;
if (local) {
  writeFileSync(out, readFileSync(local));
  console.log(`rules: ${local}`);
} else {
  const ref = process.env.RULES_REF ?? 'main';
  const res = await fetch(`https://raw.githubusercontent.com/huishouden/rules/${ref}/firestore.rules`);
  if (!res.ok) throw new Error(`rules: ${res.status} for huishouden/rules@${ref}`);
  writeFileSync(out, await res.text());
  console.log(`rules: huishouden/rules@${ref}`);
}
