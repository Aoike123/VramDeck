'use client';
import { useCallback, useEffect, useState } from 'react';
import { formatBytesToGib, formatMbToGib, formatNumber, t } from './i18n.mjs';
import { ActionButton } from './ui-controls.mjs';

export default function HubPanel({ data = null, locale = 'en' }) {
  const [catalog, setCatalog] = useState({ engines: [], models: [], downloads: [] });
  const [discovered, setDiscovered] = useState([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [tab, setTab] = useState('engines');
  const [packFilter, setPackFilter] = useState('core');
  const [mirror, setMirror] = useState('huggingface');
  const [linkForm, setLinkForm] = useState({ id: '', engine_id: 'llama-cpp', dir: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  const loadCatalog = useCallback(async () => {
    try {
      const res = await fetch('/api/hub/catalog', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? t(locale, 'apiErrorBanner'));
      setCatalog({
        engines: Array.isArray(body.engines) ? body.engines : [],
        models: Array.isArray(body.models) ? body.models : [],
        downloads: Array.isArray(body.downloads) ? body.downloads : [],
      });
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t(locale, 'apiErrorBanner'));
    }
  }, [locale]);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  async function scanLocal() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/hub/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? t(locale, 'apiErrorBanner'));
      setDiscovered(Array.isArray(body.services) ? body.services : []);
      setHasScanned(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t(locale, 'apiErrorBanner'));
    } finally {
      setBusy(false);
    }
  }

  async function adoptService(svc) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/hub/adopt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(svc),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? t(locale, 'apiErrorBanner'));
      setStatusMessage(t(locale, 'hubMsgAdopted', { name: body.adopted?.id ?? svc.name }));
      await loadCatalog();
    } catch (err) {
      setError(err instanceof Error ? err.message : t(locale, 'apiErrorBanner'));
    } finally {
      setBusy(false);
    }
  }

  async function installEngine(id) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/hub/engines/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? t(locale, 'apiErrorBanner'));
      setStatusMessage(t(locale, 'hubMsgEnabled', { id }));
      await loadCatalog();
    } catch (err) {
      setError(err instanceof Error ? err.message : t(locale, 'apiErrorBanner'));
    } finally {
      setBusy(false);
    }
  }

  async function pullModel(modelId) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/hub/models/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id: modelId, mirror }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? t(locale, 'apiErrorBanner'));
      setStatusMessage(t(locale, 'hubMsgQueued', { target: body.target ?? modelId, mirror }));
      await loadCatalog();
    } catch (err) {
      setError(err instanceof Error ? err.message : t(locale, 'apiErrorBanner'));
    } finally {
      setBusy(false);
    }
  }

  async function submitLink(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/hub/models/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(linkForm),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? t(locale, 'apiErrorBanner'));
      setStatusMessage(t(locale, 'hubMsgLinked', { id: body.linked?.id ?? linkForm.id }));
      setLinkForm({ id: '', engine_id: 'llama-cpp', dir: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : t(locale, 'apiErrorBanner'));
    } finally {
      setBusy(false);
    }
  }

  const gpus = Array.isArray(data?.gpus) ? data.gpus : [];
  const poolTotalMb = gpus.reduce(
    (sum, g) => sum + (Number.isFinite(g.vram_total_mb) ? g.vram_total_mb : 0),
    0,
  );
  const poolFreeMb = gpus.reduce((sum, g) => {
    const total = Number.isFinite(g.vram_total_mb) ? g.vram_total_mb : 0;
    const used = Number.isFinite(g.vram_used_mb) ? g.vram_used_mb : 0;
    return sum + (Number.isFinite(g.vram_free_mb) ? g.vram_free_mb : Math.max(0, total - used));
  }, 0);

  const coreEngines = catalog.engines.filter((e) => !e.pack);
  const proEngines = catalog.engines.filter((e) => e.pack === 'rocm-pro');
  const shownEngines =
    packFilter === 'core' ? coreEngines : packFilter === 'rocm-pro' ? proEngines : catalog.engines;

  const fitCount = catalog.models.filter(
    (m) => (m.fit ?? (m.fits ? 'fits' : 'too_large')) !== 'too_large',
  ).length;

  function fitBadge(fit) {
    if (fit === 'fits') return ['is-ok', t(locale, 'hubFitFits')];
    if (fit === 'tight') return ['is-warn', t(locale, 'hubFitTight')];
    return ['is-bad', t(locale, 'hubFitTooLarge')];
  }

  return (
    <div className="ak">
      <section className="ak-status" aria-label={t(locale, 'headingHubTitle')}>
        <div>
          <span>{t(locale, 'hubStatPool')}</span>
          <strong>
            {gpus.length > 0 ? formatMbToGib(poolTotalMb, locale) : t(locale, 'deviceCpuStandby')}
          </strong>
          <small>
            {gpus.length > 0
              ? t(locale, 'hubStatDevicesCount', {
                  n: formatNumber(gpus.length, locale, 0),
                  free: formatMbToGib(poolFreeMb, locale),
                })
              : t(locale, 'hubStatCpuMode')}
          </small>
        </div>
        <div>
          <span>{t(locale, 'hubStatEngines')}</span>
          <strong>{formatNumber(catalog.engines.length, locale, 0)}</strong>
          <small>
            {t(locale, 'hubStatCorePro', {
              core: formatNumber(coreEngines.length, locale, 0),
              pro: formatNumber(proEngines.length, locale, 0),
            })}
          </small>
        </div>
        <div>
          <span>{t(locale, 'hubStatWeights')}</span>
          <strong>
            {formatNumber(fitCount, locale, 0)}
            <em>/ {formatNumber(catalog.models.length, locale, 0)}</em>
          </strong>
          <small>
            {t(locale, 'hubStatFitCount', {
              fit: formatNumber(fitCount, locale, 0),
              total: formatNumber(catalog.models.length, locale, 0),
            })}
          </small>
        </div>
        <div>
          <span>{t(locale, 'hubStatDiscovery')}</span>
          <strong>
            {catalog.downloads.length > 0
              ? formatNumber(catalog.downloads.length, locale, 0)
              : formatNumber(discovered.length, locale, 0)}
          </strong>
          <small>
            {catalog.downloads.length > 0
              ? t(locale, 'hubStatDownloadsActive', {
                  n: formatNumber(catalog.downloads.length, locale, 0),
                })
              : hasScanned
                ? t(locale, 'hubStatDiscoveredCount', {
                    n: formatNumber(discovered.length, locale, 0),
                  })
                : t(locale, 'hubStatReadyScan')}
          </small>
        </div>
      </section>

      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {statusMessage && (
        <div className="ak-probe is-ok" role="status">
          <span>{statusMessage}</span>
        </div>
      )}

      <div className="ak-tabs" role="tablist" aria-label={t(locale, 'headingHubTitle')}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'engines'}
          onClick={() => setTab('engines')}
        >
          {t(locale, 'hubTabEngines')}
          <span>{catalog.engines.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'models'}
          onClick={() => setTab('models')}
        >
          {t(locale, 'hubTabModels')}
          <span>{catalog.models.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'discovery'}
          onClick={() => setTab('discovery')}
        >
          {t(locale, 'hubTabDiscovery')}
          <span>{discovered.length}</span>
        </button>
      </div>

      {tab === 'engines' && (
        <section className="ak-panel">
          <div className="hub-toolbar">
            <div className="hub-segment" role="group" aria-label={t(locale, 'hubTabEngines')}>
              <button
                type="button"
                aria-pressed={packFilter === 'core'}
                onClick={() => setPackFilter('core')}
              >
                {t(locale, 'hubFilterCore', { n: coreEngines.length })}
              </button>
              <button
                type="button"
                aria-pressed={packFilter === 'rocm-pro'}
                onClick={() => setPackFilter('rocm-pro')}
              >
                {t(locale, 'hubFilterRocmPro', { n: proEngines.length })}
              </button>
              <button
                type="button"
                aria-pressed={packFilter === 'all'}
                onClick={() => setPackFilter('all')}
              >
                {t(locale, 'hubFilterAll', { n: catalog.engines.length })}
              </button>
            </div>
          </div>

          <ul className="hub-list">
            {shownEngines.map((eng) => (
              <li key={eng.id} className="hub-row">
                <div className="hub-row-main">
                  <div className="hub-row-title">
                    <strong>{eng.name}</strong>
                    <span className="pool-keycap">{eng.driver}</span>
                    {eng.min_vram_mb > 0 && (
                      <span className="muted tiny">
                        {t(locale, 'hubMinVram', {
                          vram: formatMbToGib(eng.min_vram_mb, locale, 0),
                        })}
                      </span>
                    )}
                    {eng.pack && <span className="pool-keycap">{eng.pack}</span>}
                  </div>
                  <p className="muted tiny">{eng.description}</p>
                  <div className="hub-backends">
                    {(eng.backends ?? []).map((b) => (
                      <span key={b} className="pool-keycap">
                        {String(b).toUpperCase()}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="hub-row-action">
                  <ActionButton disabled={busy} onClick={() => installEngine(eng.id)}>
                    {t(locale, 'hubEnableButton')}
                  </ActionButton>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === 'models' && (
        <section className="ak-panel">
          <div className="hub-toolbar">
            <div className="hub-mirror-bar">
              <span className="muted tiny">{t(locale, 'hubMirrorLabel')}</span>
              <div className="hub-segment" role="group" aria-label={t(locale, 'hubMirrorLabel')}>
                {[
                  ['huggingface', 'Hugging Face'],
                  ['hf-mirror', 'HF-Mirror'],
                  ['modelscope', 'ModelScope'],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={mirror === value}
                    onClick={() => setMirror(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <span className="muted tiny">
              {t(locale, 'hubFitSummary', {
                fit: formatNumber(fitCount, locale, 0),
                total: formatNumber(catalog.models.length, locale, 0),
              })}
            </span>
          </div>

          <div className="task-table-wrap">
            <table className="task-table hub-table">
              <thead>
                <tr>
                  <th>{t(locale, 'hubColModel')}</th>
                  <th>{t(locale, 'hubColQuant')}</th>
                  <th>{t(locale, 'hubColSize')}</th>
                  <th>{t(locale, 'hubColVram')}</th>
                  <th>{t(locale, 'hubColFit')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {catalog.models.map((m) => {
                  const fit = m.fit ?? (m.fits ? 'fits' : 'too_large');
                  const [tone, label] = fitBadge(fit);
                  return (
                    <tr key={m.id}>
                      <td>
                        <div className="hub-model-cell">
                          <strong>{m.name}</strong>
                          <code>{m.engine_id}</code>
                        </div>
                      </td>
                      <td>
                        <span className="pool-keycap">{m.quantization ?? 'weights'}</span>
                      </td>
                      <td>{formatBytesToGib(m.size_bytes, locale)}</td>
                      <td>{formatMbToGib(m.recommended_vram_mb, locale)}</td>
                      <td>
                        <span className={`ak-badge ${tone}`}>
                          <i />
                          {label}
                        </span>
                      </td>
                      <td className="hub-cell-action">
                        <ActionButton disabled={busy} onClick={() => pullModel(m.id)}>
                          {t(locale, 'hubPullButton')}
                        </ActionButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {catalog.downloads.length > 0 && (
            <div className="ak-card">
              <h3>{t(locale, 'hubDownloadsTitle')}</h3>
              <ul className="hub-list">
                {catalog.downloads.map((dl) => (
                  <li key={dl.id ?? dl.target} className="hub-row">
                    <div className="hub-row-main">
                      <strong>{dl.target ?? dl.id}</strong>
                      <span className="muted tiny">
                        {dl.mirror} · {dl.status}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <form onSubmit={submitLink} className="ak-create">
            <div className="ak-field-wide">
              <h3>{t(locale, 'hubLinkTitle')}</h3>
            </div>
            <label className="ak-field">
              <span>{t(locale, 'hubLinkIdLabel')}</span>
              <input
                placeholder={t(locale, 'hubLinkIdPlaceholder')}
                value={linkForm.id}
                onChange={(e) => setLinkForm((prev) => ({ ...prev, id: e.target.value }))}
              />
            </label>
            <label className="ak-field">
              <span>{t(locale, 'hubLinkEngineLabel')}</span>
              <input
                placeholder={t(locale, 'hubLinkEnginePlaceholder')}
                value={linkForm.engine_id}
                onChange={(e) => setLinkForm((prev) => ({ ...prev, engine_id: e.target.value }))}
              />
            </label>
            <label className="ak-field">
              <span>{t(locale, 'hubLinkDirLabel')}</span>
              <input
                placeholder={t(locale, 'hubLinkDirPlaceholder')}
                value={linkForm.dir}
                onChange={(e) => setLinkForm((prev) => ({ ...prev, dir: e.target.value }))}
              />
            </label>
            <div className="ak-edit-foot">
              <small>{t(locale, 'hubLinkDesc')}</small>
              <ActionButton variant="primary" type="submit" disabled={busy}>
                {t(locale, 'hubLinkSubmit')}
              </ActionButton>
            </div>
          </form>
        </section>
      )}

      {tab === 'discovery' && (
        <section className="ak-panel">
          <div className="ak-card">
            <div className="ak-toolbar">
              <div>
                <h3>{t(locale, 'hubScanTitle')}</h3>
                <small>{t(locale, 'hubScanDesc')}</small>
              </div>
              <ActionButton variant="primary" disabled={busy} onClick={scanLocal}>
                {busy ? t(locale, 'hubScanningButton') : t(locale, 'hubScanButton')}
              </ActionButton>
            </div>

            {hasScanned && discovered.length === 0 && (
              <p className="muted tiny">{t(locale, 'hubScanEmpty')}</p>
            )}

            {discovered.length > 0 && (
              <ul className="ak-keys">
                {discovered.map((svc) => (
                  <li key={svc.url} className="ak-key">
                    <div className="ak-key-main">
                      <div className="ak-key-name">
                        <strong>{svc.name}</strong>
                        <code>{svc.url}</code>
                      </div>
                      <span className="pool-keycap">{svc.kind}</span>
                    </div>
                    <div />
                    <div className="ak-key-actions">
                      <ActionButton disabled={busy} onClick={() => adoptService(svc)}>
                        {t(locale, 'hubAdoptButton')}
                      </ActionButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
