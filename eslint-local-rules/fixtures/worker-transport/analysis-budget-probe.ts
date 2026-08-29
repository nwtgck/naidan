declare function wrapWorkerRemote<Api>(options: { endpoint: unknown }): Api;

interface BudgetProbeApi {
  run(request: {
    nested: {
      value: string,
    },
  }): Promise<void>,
}

wrapWorkerRemote<BudgetProbeApi>({ endpoint: undefined });
