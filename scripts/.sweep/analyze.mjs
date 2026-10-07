import fs from "node:fs";

const files = process.argv.slice(2);
for (const f of files) {
  const html = fs.readFileSync(f, "utf8");
  console.log("\n================ " + f + " ================");
  // forms
  const forms = html.match(/<form\b[\s\S]*?<\/form>/g) || [];
  console.log(`forms: ${forms.length}`);
  const seen = new Map();
  for (const fo of forms) {
    const action = (fo.match(/action="([^"]*)"/) || [, "(self)"])[1];
    const method = (fo.match(/method="([^"]*)"/) || [, "GET"])[1].toUpperCase();
    const fields = [...fo.matchAll(/<(input|select|textarea)\b[^>]*>/g)]
      .map((m) => m[0])
      .map((tag) => {
        const type = (tag.match(/type="([^"]*)"/) || [, "text"])[1];
        const name = (tag.match(/name="([^"]*)"/) || [, ""])[1];
        if (!name) return null;
        return `${name}:${type}`;
      })
      .filter(Boolean);
    const key = `${method} ${action} :: ${fields.join(",")}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  for (const [k, n] of seen) console.log(`  x${n}  ${k.slice(0, 400)}`);

  // buttons outside forms
  const noForm = html.replace(/<form\b[\s\S]*?<\/form>/g, "");
  const btns = [...noForm.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
  console.log(`buttons outside forms: ${btns.length}`);
  const bseen = new Map();
  for (const b of btns) {
    const attrs = b.replace(/<button\s*/, "").replace(/>$/, "");
    const k = attrs.slice(0, 200);
    bseen.set(k, (bseen.get(k) || 0) + 1);
  }
  for (const [k, n] of bseen) console.log(`  x${n}  <button ${k}>`);

  // anchors that look like actions
  const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]{0,60}?)<\/a>/g)];
  const act = links.filter((m) => /\/(config|settings|templates|staff|case|export)\//.test(m[1]));
  const lseen = new Map();
  for (const m of act) {
    const k = m[1] + "   |   " + m[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    lseen.set(k, (lseen.get(k) || 0) + 1);
  }
  if (lseen.size) {
    console.log(`action links: ${act.length}`);
    for (const [k, n] of lseen) console.log(`  x${n}  ${k.slice(0, 220)}`);
  }
}
