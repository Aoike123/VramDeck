'use client';
import { formatMbToGib, formatNumber, t } from './i18n.mjs';

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

  const poolTotalMb = gpus.reduce(
    (sum, g) => sum + (Number.isFinite(g.vram_total_mb) ? g.vram_total_mb : 0),
    0,
  );
  const poolFreeMb = gpus.reduce((sum, g) => {
    const total = Number.isFinite(g.vram_total_mb) ? g.vram_total_mb : 0;
    const used = Number.isFinite(g.vram_used_mb) ? g.vram_used_mb : 0;
    const free = Number.isFinite(g.vram_free_mb) ? g.vram_free_mb : Math.max(0, total - used);
    return sum + free;
  }, 0);

  return (
    <section className="mcp-card pool-section" aria-label={t(locale, 'topologyTitle')}>
      <div className="charthead">
        <h2>{t(locale, 'topologyTitle')}</h2>
        <span className="muted tiny pool-summary">
          {gpus.length > 0
            ? t(locale, 'topologyPoolSummary', {
                free: formatMbToGib(poolFreeMb, locale),
                total: formatMbToGib(poolTotalMb, locale),
                count: formatNumber(gpus.length, locale, 0),
              })
            : host
              ? t(locale, 'topologyStandbySummary', { os: host.os, arch: host.arch })
              : t(locale, 'topologyStandbyTitle')}
        </span>
      </div>

      {gpus.length === 0 ? (
        <div className="pool-grid">
          <article className="pool-device-card">
            <div className="pool-device-head">
              <div className="pool-device-id">
                <span className="pool-keycap">CPU</span>
                <strong>{t(locale, 'topologyStandbyTitle')}</strong>
              </div>
              {host && (
                <span className="pool-tag">
                  {host.os}/{host.arch}
                </span>
              )}
            </div>
            <p className="muted tiny">{t(locale, 'topologyStandbyDesc')}</p>
            {host && (
              <>
                {(() => {
                  const ramTotal = Number.isFinite(host.ram_total_mb) ? host.ram_total_mb : 0;
                  const ramFree = Number.isFinite(host.ram_free_mb) ? host.ram_free_mb : 0;
                  const ramUsed = Math.max(0, ramTotal - ramFree);
                  const ramPct =
                    ramTotal > 0 ? Math.min(100, Math.round((ramUsed / ramTotal) * 100)) : 0;
                  return (
                    <>
                      <div className="pool-vram-head">
                        <div className="pool-vram-figure">
                          <b>{formatMbToGib(ramUsed, locale)}</b>
                          <span> / {formatMbToGib(ramTotal, locale)}</span>
                        </div>
                        <span className="muted tiny">
                          {formatMbToGib(ramFree, locale)} {t(locale, 'topologyFree')} ·{' '}
                          {pctLabel(ramPct, locale)}
                        </span>
                      </div>
                      <div className="pool-vram-bar" aria-hidden="true">
                        <span className="pool-seg is-sys" style={{ width: `${ramPct}%` }} />
                      </div>
                    </>
                  );
                })()}
              </>
            )}
          </article>
        </div>
      ) : (
        <div className="pool-grid">
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
            const allocatedMb = gpuAllocations.reduce((sum, alloc) => {
              const slot = alloc.slots.find((s) => s.gpu_id === gpu.id);
              return sum + (Number.isFinite(slot?.reserved_mb) ? slot.reserved_mb : 0);
            }, 0);
            const systemMb = Math.max(0, usedMb - allocatedMb);
            const systemPct =
              totalMb > 0 ? Math.min(100, Math.round((systemMb / totalMb) * 100)) : 0;

            return (
              <article key={gpu.id} className="pool-device-card">
                <div className="pool-device-head">
                  <div className="pool-device-id">
                    <span className="pool-keycap">#{gpu.index}</span>
                    <strong>{gpu.name}</strong>
                  </div>
                  <span className="pool-tag">
                    {String(gpu.backend ?? gpu.vendor ?? '').toUpperCase()}
                    {gpu.unified_memory ? ' · UMA' : ''}
                  </span>
                </div>

                <div className="pool-vram-head">
                  <div className="pool-vram-figure">
                    <b>{formatMbToGib(usedMb, locale)}</b>
                    <span> / {formatMbToGib(totalMb, locale)}</span>
                  </div>
                  <span className="muted tiny">
                    {formatMbToGib(freeMb, locale)} {t(locale, 'topologyFree')} ·{' '}
                    {pctLabel(usedPct, locale)}
                  </span>
                </div>

                <div className="pool-vram-bar" aria-hidden="true">
                  {gpuAllocations.map((alloc, i) => {
                    const slot = alloc.slots.find((s) => s.gpu_id === gpu.id);
                    const slotMb = Number.isFinite(slot?.reserved_mb) ? slot.reserved_mb : 0;
                    const slotPct = totalMb > 0 ? Math.max(1, (slotMb / totalMb) * 100) : 0;
                    return (
                      <span
                        key={alloc.allocation_id}
                        className={`pool-seg ${i % 2 === 0 ? 'is-accent' : 'is-cyan'}`}
                        style={{ width: `${Math.min(100, slotPct)}%` }}
                      />
                    );
                  })}
                  {systemPct > 0 && (
                    <span
                      className={`pool-seg ${usedPct > 85 ? 'is-warn' : gpuAllocations.length > 0 ? 'is-sys' : 'is-cyan'}`}
                      style={{ width: `${systemPct}%` }}
                    />
                  )}
                </div>

                {gpuAllocations.length > 0 && (
                  <div className="pool-legend">
                    {gpuAllocations.map((alloc, i) => {
                      const slot = alloc.slots.find((s) => s.gpu_id === gpu.id);
                      return (
                        <span key={alloc.allocation_id} className="pool-legend-item">
                          <i className={i % 2 === 0 ? 'is-accent' : 'is-cyan'} />
                          <code>{alloc.engine}</code>
                          <small>
                            {formatMbToGib(slot?.reserved_mb, locale)} ({alloc.active_leases}/
                            {alloc.capacity})
                          </small>
                        </span>
                      );
                    })}
                  </div>
                )}

                <dl className="pool-telemetry">
                  <div>
                    <dt>{t(locale, 'topologyUtil')}</dt>
                    <dd>{pctLabel(gpu.utilization_pct, locale)}</dd>
                  </div>
                  <div>
                    <dt>{t(locale, 'topologyTemp')}</dt>
                    <dd>
                      {gpu.temperature_c != null && Number.isFinite(gpu.temperature_c)
                        ? `${formatNumber(gpu.temperature_c, locale, 0)}°C`
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>{t(locale, 'topologyPower')}</dt>
                    <dd>
                      {gpu.power_w != null && Number.isFinite(gpu.power_w)
                        ? `${formatNumber(gpu.power_w, locale, 0)} W`
                        : '—'}
                    </dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </div>
      )}

      {allocations.length === 0 ? (
        <p className="pool-idle-note">{t(locale, 'topologyNoAllocations')}</p>
      ) : (
        <div className="pool-alloc-wrap">
          <div className="charthead">
            <h3>{t(locale, 'topologyAllocated')}</h3>
          </div>
          <div className="task-table-wrap">
            <table className="task-table">
              <thead>
                <tr>
                  <th>{t(locale, 'topologyColEngine')}</th>
                  <th>{t(locale, 'topologyColRuntime')}</th>
                  <th>{t(locale, 'topologyColPlacement')}</th>
                  <th>{t(locale, 'topologyColMode')}</th>
                  <th>{t(locale, 'topologyColLeases')}</th>
                </tr>
              </thead>
              <tbody>
                {allocations.map((alloc) => (
                  <tr key={alloc.allocation_id}>
                    <td>
                      <code>{alloc.engine}</code>
                    </td>
                    <td>{alloc.runtime_id}</td>
                    <td>
                      {(alloc.slots ?? [])
                        .map((s) => `${s.gpu_id} · ${formatMbToGib(s.reserved_mb, locale)}`)
                        .join(', ')}
                    </td>
                    <td>
                      <span className="pool-keycap">
                        {alloc.slots?.[0]?.mode ?? t(locale, 'topologySlotMode')}
                      </span>
                    </td>
                    <td>
                      {alloc.active_leases}/{alloc.capacity}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
