export interface PluginContext {
  provide<T>(id: string, service: T): void;
  service<T>(id: string): T;
  own(cleanup: () => unknown): void;
}
export interface Plugin {
  id: string;
  requires?: string[];
  activate(context: PluginContext): void | Promise<void>;
}

/** The first SDK hosts explicitly registered trusted plugins. No arbitrary package execution. */
export class PluginHost {
  private services = new Map<string, { owner: string; value: unknown }>();
  private scopes = new Map<string, (() => unknown)[]>();
  private order: string[] = [];
  private definitions = new Map<string, Plugin>();
  private listeners = new Set<() => void>();

  /** Called after any plugin activates or is released, so status views stay current. */
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) { try { listener(); } catch (error) { console.error(error); } } }

  hasService(id: string): boolean { return this.services.has(id); }
  providedServices(owner: string): string[] {
    return [...this.services].filter(([, entry]) => entry.owner === owner).map(([id]) => id);
  }

  service<T>(id: string): T {
    const entry = this.services.get(id);
    if (!entry) throw new Error(`服务未就绪：${id}`);
    return entry.value as T;
  }

  async start(plugins: Plugin[]): Promise<void> {
    const ids = new Set<string>();
    for (const plugin of plugins) {
      if (ids.has(plugin.id) || this.scopes.has(plugin.id)) throw new Error(`重复插件：${plugin.id}`);
      ids.add(plugin.id);
    }
    const remaining = [...plugins];
    const activated: string[] = [];
    try {
      while (remaining.length) {
        const index = remaining.findIndex(p => (p.requires ?? []).every(id => this.services.has(id)));
        if (index < 0) throw new Error(`缺少服务或依赖循环：${remaining.map(p => p.id).join(', ')}`);
        const plugin = remaining.splice(index, 1)[0];
        const scope: (() => unknown)[] = [];
        this.scopes.set(plugin.id, scope);
        const context: PluginContext = {
          service: <T>(id: string) => {
            if (this.scopes.get(plugin.id) !== scope) throw new Error(`插件作用域已释放：${plugin.id}`);
            return this.service<T>(id);
          },
          own: cleanup => {
            if (this.scopes.get(plugin.id) === scope) scope.push(cleanup);
            else { try { void Promise.resolve(cleanup()).catch(console.error); } catch (error) { console.error(error); } }
          },
          provide: <T>(id: string, service: T) => {
            if (this.scopes.get(plugin.id) !== scope) throw new Error(`插件作用域已释放：${plugin.id}`);
            if (this.services.has(id)) throw new Error(`服务已存在：${id}`);
            this.services.set(id, { owner: plugin.id, value: service });
            scope.push(() => { if (this.services.get(id)?.owner === plugin.id) this.services.delete(id); });
          },
        };
        try { await plugin.activate(context); }
        catch (error) { await this.releaseAsync(plugin.id); throw error; }
        this.order.push(plugin.id);
        this.definitions.set(plugin.id, plugin);
        activated.push(plugin.id);
        this.changed();
      }
    } catch (error) {
      for (const id of activated.reverse()) await this.releaseAsync(id);
      throw error;
    }
  }

  private release(id: string): void {
    const scope = this.detach(id);
    for (const cleanup of scope.reverse()) { try { void Promise.resolve(cleanup()).catch(console.error); } catch (error) { console.error(error); } }
  }

  private detach(id: string) {
    const scope = this.scopes.get(id) ?? [];
    this.scopes.delete(id);
    this.definitions.delete(id);
    this.order = this.order.filter(item => item !== id);
    if (scope.length || this.listeners.size) queueMicrotask(() => this.changed());
    return scope;
  }

  private async releaseAsync(id: string): Promise<void> {
    const scope = this.detach(id), failures: unknown[] = [];
    for (const cleanup of scope.reverse()) { try { await cleanup(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new Error(`插件资源释放失败：${id}：${failures.map(String).join('；')}`);
  }

  stop(): void { for (const id of [...this.order].reverse()) this.release(id); }
  deactivate(id: string): void {
    this.assertNoDependents(id);
    this.release(id);
  }
  private assertNoDependents(id: string): void {
    const services = this.providedServices(id);
    const dependents = [...this.definitions.values()].filter(p => p.id !== id && p.requires?.some(service => services.includes(service)));
    if (dependents.length) throw new Error(`插件仍被依赖：${dependents.map(p => p.id).join(', ')}`);
  }

  definition(id: string): Plugin | undefined { return this.definitions.get(id); }

  /** Call only through the serialized management queue. Load/validate before stopping old code. */
  async replace(id: string, next: Plugin): Promise<void> {
    if (next.id !== id || typeof next.activate !== 'function' || (next.requires && (!Array.isArray(next.requires) || next.requires.some(s => typeof s !== 'string')))) throw new Error('重载插件的 ID 或接口无效');
    const previous = this.definitions.get(id);
    if (!previous) throw new Error(`请先启用插件：${id}`);
    this.assertNoDependents(id);
    const services = this.providedServices(id);
    try {
      await this.releaseAsync(id);
      await this.start([next]);
      if (services.some(service => !this.providedServices(id).includes(service))) throw new Error('新插件缺少原有服务，无法替换');
    } catch (error) {
      try {
        if (this.scopes.has(id)) await this.releaseAsync(id);
        await this.start([previous]);
      } catch (restore) { throw new Error(`重载失败且上一版恢复失败：${String(error)}；${String(restore)}`); }
      throw new Error(`重载失败，已恢复上一版：${String(error)}`);
    }
  }
  get activePlugins(): string[] { return [...this.order]; }
}
