/**
 * Pobiera komplet XSD FA(3) do src/fa3/schema/ (FA3 + 3 importowane pliki etd).
 * Uruchom przy aktualizacji schematu:  npm run fetch-schema
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "..", "src", "fa3", "schema");
const ETD = "http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/01/05/eD/DefinicjeTypy/";

const FILES: Array<{ url: string; name: string }> = [
  {
    url: "https://raw.githubusercontent.com/CIRFMF/ksef-docs/main/faktury/schemy/FA/schemat_FA(3)_v1-0E.xsd",
    name: "FA3.xsd",
  },
  { url: ETD + "StrukturyDanych_v10-0E.xsd", name: "StrukturyDanych_v10-0E.xsd" },
  { url: ETD + "ElementarneTypyDanych_v10-0E.xsd", name: "ElementarneTypyDanych_v10-0E.xsd" },
  { url: ETD + "KodyKrajow_v10-0E.xsd", name: "KodyKrajow_v10-0E.xsd" },
];

for (const f of FILES) {
  const res = await fetch(f.url);
  if (!res.ok) {
    console.error(`BŁĄD ${res.status} pobierając ${f.url}`);
    process.exit(1);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  writeFileSync(join(OUT, f.name), buf);
  console.log(`${f.name}: ${buf.byteLength} B`);
}
console.log("Schemat FA(3) zaktualizowany.");
