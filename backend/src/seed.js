const HOUR_MS = 60 * 60 * 1000;

export function createSeedIncidents(now = new Date()) {
  const base = now.getTime();

  return [
    {
      createdAt: new Date(base - 5 * HOUR_MS).toISOString(),
      description: 'Checkout traffic is elevated after the campaign launch.',
      id: 'inc-seed-checkout-latency',
      owner: 'platform',
      priority: 'critical',
      status: 'in_progress',
      title: 'Checkout latency above target',
      updatedAt: new Date(base - 90 * 60 * 1000).toISOString()
    },
    {
      createdAt: new Date(base - 11 * HOUR_MS).toISOString(),
      description: 'Mobile clients report stale inventory numbers for some products.',
      id: 'inc-seed-inventory-sync',
      owner: 'backend',
      priority: 'high',
      status: 'open',
      title: 'Inventory sync delay',
      updatedAt: new Date(base - 3 * HOUR_MS).toISOString()
    },
    {
      createdAt: new Date(base - 26 * HOUR_MS).toISOString(),
      description: 'Resolved after the CDN cache rule was corrected.',
      id: 'inc-seed-assets',
      owner: 'frontend',
      priority: 'medium',
      status: 'resolved',
      title: 'Static asset cache mismatch',
      updatedAt: new Date(base - 19 * HOUR_MS).toISOString()
    }
  ];
}
