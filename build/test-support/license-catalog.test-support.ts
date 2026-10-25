import type { NaidanLicense, NaidanLicenseCatalog } from '../../src/01-models/naidan-license';

/** Exercise every generated reader without asserting minifier-specific syntax. */
export function restoreLicenseCatalog({ factory }: { factory: unknown }): readonly NaidanLicense[] {
  if (typeof factory !== 'function') {
    throw new Error('Expected a license catalog factory, not an eagerly restored array');
  }
  const catalog = factory() as NaidanLicenseCatalog;
  return catalog.entries.map((entry, index) => ({ ...entry, licenseText: catalog.readLicenseText({ index }) }));
}
