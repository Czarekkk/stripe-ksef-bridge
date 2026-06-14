/**
 * Walidacja XML FA(3) wg oficjalnego XSD (schemat_FA(3)_v1-0E).
 *
 * libxml2-wasm nie ma dostępu do sieci/FS przy rozwiązywaniu importów schematu,
 * więc rejestrujemy XmlBufferInputProvider mapujący absolutne URL-e schematów
 * (etd: StrukturyDanych -> ElementarneTypyDanych -> KodyKrajow) na lokalne pliki.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  XmlBufferInputProvider,
  XmlDocument,
  XmlValidateError,
  XsdValidator,
  xmlRegisterInputProvider,
} from "libxml2-wasm";

const ETD_BASE = "http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/01/05/eD/DefinicjeTypy/";

let validator: XsdValidator | null = null;
// Trzymamy referencję, żeby GC nie zwolnił dokumentu schematu używanego przez walidator.
let schemaDoc: XmlDocument | null = null;

function init(): XsdValidator {
  if (validator) return validator;
  const dir = join(import.meta.dirname, "schema");
  const read = (f: string): Uint8Array => new Uint8Array(readFileSync(join(dir, f)));

  xmlRegisterInputProvider(
    new XmlBufferInputProvider({
      [ETD_BASE + "StrukturyDanych_v10-0E.xsd"]: read("StrukturyDanych_v10-0E.xsd"),
      [ETD_BASE + "ElementarneTypyDanych_v10-0E.xsd"]: read("ElementarneTypyDanych_v10-0E.xsd"),
      [ETD_BASE + "KodyKrajow_v10-0E.xsd"]: read("KodyKrajow_v10-0E.xsd"),
    }),
  );

  schemaDoc = XmlDocument.fromBuffer(read("FA3.xsd"));
  validator = XsdValidator.fromDoc(schemaDoc);
  return validator;
}

export interface Fa3ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Waliduje XML FA(3). Zwraca listę błędów (pustą gdy poprawny). */
export function validateFa3(xml: string): Fa3ValidationResult {
  const v = init();
  const doc = XmlDocument.fromString(xml);
  try {
    v.validate(doc);
    return { ok: true, errors: [] };
  } catch (e) {
    if (e instanceof XmlValidateError) {
      const errors = String(e.message)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      return { ok: false, errors };
    }
    throw e;
  } finally {
    doc.dispose();
  }
}
