/**
 * pdf.js (>=6.1) appelle Map.prototype.getOrInsert / getOrInsertComputed
 * (proposal ES récente). Present dans Chrome pour Android, absent du WebKit
 * iOS du terrain (plante avec "this.#objs.getOrInsertComputed is not a
 * function" dans pdf_objects.js → api.js). Polyfill feature-détecté, posé
 * AVANT tout import de pdfjs-dist — voir PdfViewer.tsx et main.tsx.
 */

type GetOrInsertable<K, V> = {
  has(key: K): boolean;
  get(key: K): V | undefined;
  set(key: K, value: V): unknown;
};

function getOrInsert<K, V>(this: GetOrInsertable<K, V>, key: K, value: V): V {
  if (this.has(key)) return this.get(key) as V;
  this.set(key, value);
  return value;
}

function getOrInsertComputed<K, V>(this: GetOrInsertable<K, V>, key: K, callback: (key: K) => V): V {
  if (this.has(key)) return this.get(key) as V;
  const value = callback(key);
  this.set(key, value);
  return value;
}

function definePolyfillMethod(target: object, name: string, fn: (...args: never[]) => unknown): void {
  if (typeof (target as Record<string, unknown>)[name] === 'function') return;
  Object.defineProperty(target, name, {
    value: fn,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

definePolyfillMethod(Map.prototype, 'getOrInsert', getOrInsert);
definePolyfillMethod(Map.prototype, 'getOrInsertComputed', getOrInsertComputed);
definePolyfillMethod(WeakMap.prototype, 'getOrInsert', getOrInsert);
definePolyfillMethod(WeakMap.prototype, 'getOrInsertComputed', getOrInsertComputed);
