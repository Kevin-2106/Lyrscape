import { desktop, native } from '../platform';
import { PLUGIN_ID } from './registry';

/** The files of one installed plugin: `<id>.mjs` and an optional `<id>.css`. */
export interface PluginFiles { id: string; javascript: string; css: string }

/**
 * Where installed plugins live. The desktop app keeps them as plain files in the
 * `plugins` folder beside the exe (editable, portable); the browser preview keeps
 * them in IndexedDB. Both are read by the same catalog rescan.
 */
export interface PluginStorage {
  readonly label: string;
  list(): Promise<string[]>;
  read(id: string): Promise<PluginFiles>;
  write(files: PluginFiles): Promise<void>;
  remove(id: string): Promise<void>;
  /** Opens the folder in the system file manager (desktop only). */
  reveal?(): Promise<void>;
}

const nativeStorage: PluginStorage = {
  label: 'exe 旁的 plugins 文件夹',
  list: () => native<string[]>('plugin_catalog'),
  read: id => native<PluginFiles>('plugin_source', { id }),
  write: files => native('plugin_install', { id: files.id, javascript: files.javascript, css: files.css }),
  remove: id => native('plugin_uninstall', { id }),
  reveal: () => native('plugins_folder_open'),
};

const DB = 'lyrscape-plugins', STORE = 'files';
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? Error('无法打开浏览器插件存储'));
  });
}
async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode), request = run(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? request.error ?? Error('浏览器插件存储失败'));
    });
  } finally { db.close(); }
}

const browserStorage: PluginStorage = {
  label: '浏览器本地存储',
  async list() { return (await transact('readonly', store => store.getAllKeys())).map(String).filter(id => PLUGIN_ID.test(id)).sort(); },
  async read(id) {
    const files = await transact<PluginFiles | undefined>('readonly', store => store.get(id));
    if (!files) throw Error(`找不到已安装的插件：${id}`);
    return files;
  },
  async write(files) { await transact('readwrite', store => store.put({ id: files.id, javascript: files.javascript, css: files.css })); },
  async remove(id) { await transact('readwrite', store => store.delete(id)); },
};

export const pluginStorage: PluginStorage | undefined = desktop ? nativeStorage : typeof indexedDB === 'undefined' ? undefined : browserStorage;

/** Saves an exported package: Downloads (revealed in Explorer) on desktop, a browser download otherwise. Resolves to the saved path when known. */
export async function saveExport(fileName: string, contents: string): Promise<string | undefined> {
  if (desktop) return native<string>('plugin_export_save', { fileName, contents });
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: fileName });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return undefined;
}
