export interface PluginContext {
  provide<T>(id: string, service: T): void;
  service<T>(id: string): T;
  own(cleanup: () => void): void;
}
export interface Plugin {
  id: string;
  requires?: string[];
  activate(context: PluginContext): void | Promise<void>;
}

/** The first SDK hosts explicitly registered trusted plugins. No arbitrary package execution. */
export class PluginHost {
  private services = new Map<string, { owner: string; value: unknown }>();
  private scopes = new Map<string, (() => void)[]>();
  private order: string[] = [];

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
        const scope: (() => void)[] = [];
        this.scopes.set(plugin.id, scope);
        const context: PluginContext = {
          service: <T>(id: string) => this.service<T>(id),
          own: cleanup => scope.push(cleanup),
          provide: <T>(id: string, service: T) => {
            if (this.services.has(id)) throw new Error(`服务已存在：${id}`);
            this.services.set(id, { owner: plugin.id, value: service });
            scope.push(() => { if (this.services.get(id)?.owner === plugin.id) this.services.delete(id); });
          },
        };
        try { await plugin.activate(context); }
        catch (error) { this.release(plugin.id); throw error; }
        this.order.push(plugin.id);
        activated.push(plugin.id);
      }
    } catch (error) {
      for (const id of activated.reverse()) this.release(id);
      throw error;
    }
  }

  private release(id: string): void {
    const scope = this.scopes.get(id) ?? [];
    for (const cleanup of scope.reverse()) { try { cleanup(); } catch (error) { console.error(error); } }
    this.scopes.delete(id);
    this.order = this.order.filter(item => item !== id);
  }

  stop(): void { for (const id of [...this.order].reverse()) this.release(id); }
  get activePlugins(): string[] { return [...this.order]; }
}
