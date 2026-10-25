declare module 'virtual:naidan-licenses' {
  const createLicenseCatalog: () => import('./01-models/naidan-license').NaidanLicenseCatalog;
  export default createLicenseCatalog;
}
