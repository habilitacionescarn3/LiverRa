// SPDX-License-Identifier: Apache-2.0
// Ambient declaration so `import styles from './X.module.css'` type-checks.
// Vite resolves these at build time; tsc just needs the module shape.
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}
