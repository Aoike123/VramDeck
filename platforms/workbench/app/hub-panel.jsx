'use client';
import { useCallback, useEffect, useState } from 'react';
import { t } from './i18n.mjs';
import { ActionButton } from './ui-controls.mjs';

export default function HubPanel({ locale = 'en' }) {
  const [catalog, setCatalog] = useState({ engines: [], models: [], downloads: [] });
  const [discovered, setDiscovered] = useState([]);
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
      setStatusMessage(`Adopted ${body.adopted?.id ?? svc.name}`);
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
      setStatusMessage(`Engine ${id}: ready`);
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
      setStatusMessage(`Queued ${body.target ?? modelId} (${mirror})`);
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
      setStatusMessage(`Linked ${body.linked?.id ?? linkForm.id}`);
      setLinkForm({ id: '', engine_id: 'llama-cpp', dir: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : t(locale, 'apiErrorBanner'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="control-center">
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {statusMessage && <p className="note">{statusMessage}</p>}

      <section className="mcp-card">
        <div className="charthead">
          <h2>{t(locale, 'hubScanTitle')}</h2>
          <ActionButton disabled={busy} onClick={scanLocal}>
            {t(locale, 'hubScanButton')}
          </ActionButton>
        </div>
        {discovered.length > 0 && (
          <div className="service-catalog">
            {discovered.map((svc) => (
              <div key={svc.url} className="topology-gpu-card">
                <strong>
                  {svc.name} ({svc.kind})
                </strong>
                <div className="muted tiny">{svc.url}</div>
                <ActionButton disabled={busy} onClick={() => adoptService(svc)}>
                  {t(locale, 'hubAdoptButton')}
                </ActionButton>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mcp-card">
        <div className="charthead">
          <h2>{t(locale, 'hubEnginesTitle')}</h2>
        </div>
        <div className="service-catalog">
          {catalog.engines.map((eng) => (
            <div key={eng.id} className="topology-gpu-card">
              <div className="catalog-head">
                <strong>{eng.name}</strong>
                <span className="muted tiny">
                  {eng.driver} · {Array.isArray(eng.backends) ? eng.backends.join('/') : ''}
                  {eng.pack ? ` · ${eng.pack}` : ''}
                </span>
              </div>
              <p>{eng.description}</p>
              <ActionButton disabled={busy} onClick={() => installEngine(eng.id)}>
                {t(locale, 'hubEnableButton')}
              </ActionButton>
            </div>
          ))}
        </div>
      </section>

      <section className="mcp-card">
        <div className="charthead">
          <h2>{t(locale, 'hubModelsTitle')}</h2>
          <label className="muted tiny">
            {t(locale, 'hubMirrorLabel')}:{' '}
            <select value={mirror} onChange={(e) => setMirror(e.target.value)}>
              <option value="huggingface">Hugging Face</option>
              <option value="hf-mirror">HF-Mirror</option>
              <option value="modelscope">ModelScope</option>
            </select>
          </label>
        </div>
        <div className="service-catalog">
          {catalog.models.map((m) => (
            <div key={m.id} className="topology-gpu-card">
              <div className="catalog-head">
                <strong>{m.name}</strong>
                <span className="muted tiny">
                  {m.quantization ?? 'weights'} · {m.fit ?? (m.fits ? 'fits' : 'too_large')}
                </span>
              </div>
              <ActionButton disabled={busy} onClick={() => pullModel(m.id)}>
                {t(locale, 'hubPullButton')}
              </ActionButton>
            </div>
          ))}
        </div>
      </section>

      <section className="mcp-card">
        <h2>{t(locale, 'hubLinkTitle')}</h2>
        <form onSubmit={submitLink} className="filter-row">
          <input
            placeholder="Model ID (e.g. local-qwen)"
            value={linkForm.id}
            onChange={(e) => setLinkForm((prev) => ({ ...prev, id: e.target.value }))}
          />
          <input
            placeholder="Engine ID (e.g. llama-cpp)"
            value={linkForm.engine_id}
            onChange={(e) => setLinkForm((prev) => ({ ...prev, engine_id: e.target.value }))}
          />
          <input
            placeholder="Absolute local weights directory"
            value={linkForm.dir}
            onChange={(e) => setLinkForm((prev) => ({ ...prev, dir: e.target.value }))}
          />
          <ActionButton type="submit" disabled={busy}>
            {t(locale, 'hubLinkSubmit')}
          </ActionButton>
        </form>
      </section>
    </div>
  );
}
