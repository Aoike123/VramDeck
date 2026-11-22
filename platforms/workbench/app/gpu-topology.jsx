'use client';
import { formatNumber, t } from './i18n.mjs';

function mbToGibLabel(mb, locale) {
  if (mb == null || !Number.isFinite(Number(mb))) return '—';
  return `${formatNumber(Number(mb) / 1024, locale, 1)} GiB`;
}

function pctLabel(pct, locale) {
  if (pct == null || !Number.isFinite(Number(pct))) return '—';
  return `${formatNumber(pct, locale, 0)}%`;
}

export default function GpuTopology({ data, locale = 'en' }) {
  const gpus = Array.isArray(data?.gpus) ? data.gpus : [];
  const host = data?.host ?? null;
  const allocations = Array.isArray(data?.runtime_topology?.allocations)
    ? data.runtime_topology.allocations
    : Array.isArray(data?.allocations)
      ? data.allocations
      : [];

  return (
    <section className="mcp-card" aria-label={t(locale, 'topologyTitle')}>
      <div className="charthead">
        <h2>{t(locale, 'topologyTitle')}</h2>
        <span className="muted tiny">{t(locale, 'topologySubtitle')}</span>
      </div>

      {gpus.length === 0 ? (
        <div className="topology-standby">
          <strong>{t(locale, 'topologyStandbyTitle')}</strong>
          <p className="note">{t(locale, 'topologyStandbyDesc')}</p>
          {host && (
            <div className="muted tiny">
              RAM: {mbToGibLabel(host.ram_free_mb, locale)} /{' '}
              {mbToGibLabel(host.ram_total_mb, locale)} ({host.os}/{host.arch})
            </div>
          )}
        </div>
      ) : (
        <div className="service-catalog">
          {gpus.map((gpu) => {
            const totalMb = Number.isFinite(gpu.vram_total_mb) ? gpu.vram_total_mb : 0;
            const usedMb = Number.isFinite(gpu.vram_used_mb) ? gpu.vram_used_mb : 0;
            const freeMb = Number.isFinite(gpu.vram_free_mb)
              ? gpu.vram_free_mb
              : Math.max(0, totalMb - usedMb);
            const usedPct = totalMb > 0 ? Math.min(100, Math.round((usedMb / totalMb) * 100)) : 0;
            const gpuAllocations = allocations.filter(
              (a) => Array.isArray(a.slots) && a.slots.some((s) => s.gpu_id === gpu.id),
            );

            return (
              <div key={gpu.id} className="topology-gpu-card">
                <div className="catalog-head">
                  <strong>
                    #{gpu.index} {gpu.name}
                  </strong>
                  <span className="catalog-state live">
                    {String(gpu.vendor ?? '').toUpperCase()} ·{' '}
                    {String(gpu.backend ?? '').toUpperCase()}
                    {gpu.unified_memory ? ' · UMA' : ''}
                  </span>
                </div>
                <div className="muted tiny">
                  VRAM: {mbToGibLabel(usedMb, locale)} used / {mbToGibLabel(freeMb, locale)} free /{' '}
                  {mbToGibLabel(totalMb, locale)} total ({usedPct}%)
                </div>
                <div className="muted tiny">
                  Util: {pctLabel(gpu.utilization_pct, locale)} | Temp:{' '}
                  {gpu.temperature_c != null && Number.isFinite(gpu.temperature_c)
                    ? `${formatNumber(gpu.temperature_c, locale, 0)}°C`
                    : '—'}{' '}
                  | Power:{' '}
                  {gpu.power_w != null && Number.isFinite(gpu.power_w)
                    ? `${formatNumber(gpu.power_w, locale, 0)}W`
                    : '—'}
                </div>
                {gpuAllocations.length > 0 && (
                  <div className="topology-slots">
                    {gpuAllocations.map((alloc) => {
                      const slot = alloc.slots.find((s) => s.gpu_id === gpu.id);
                      return (
                        <span key={alloc.allocation_id} className="muted tiny">
                          {alloc.engine} ({slot?.mode ?? 'shared'} · {slot?.reserved_mb ?? 0} MiB ·{' '}
                          {alloc.active_leases}/{alloc.capacity})
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="topology-allocations">
        <h3>{t(locale, 'topologyAllocated')}</h3>
        {allocations.length === 0 ? (
          <p className="note">{t(locale, 'topologyNoAllocations')}</p>
        ) : (
          <ul>
            {allocations.map((alloc) => (
              <li key={alloc.allocation_id}>
                <code>{alloc.engine}</code> ({alloc.runtime_id}) —{' '}
                {(alloc.slots ?? [])
                  .map((s) => `${s.gpu_id}:${s.reserved_mb}MB/${s.mode}`)
                  .join(', ')}{' '}
                [{alloc.active_leases}/{alloc.capacity}]
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
