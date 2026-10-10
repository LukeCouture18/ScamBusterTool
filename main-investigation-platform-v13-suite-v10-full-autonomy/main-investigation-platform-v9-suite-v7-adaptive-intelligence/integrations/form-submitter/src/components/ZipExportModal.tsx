import React, { useState } from 'react';
import {
  Download,
  ExternalLink,
  Copy,
  Check,
  Terminal,
  FileArchive,
  X,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';

interface ZipExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ZipExportModal: React.FC<ZipExportModalProps> = ({ isOpen, onClose }) => {
  const [downloading, setDownloading] = useState(false);
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  if (!isOpen) return null;

  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const directDownloadUrl = `${currentOrigin}/api/download-zip`;
  const staticZipUrl = `${currentOrigin}/project-archive.zip`;
  const curlCommand = `curl -sL "${directDownloadUrl}" -o crypto-scam-report-submitter.zip`;

  // Method 1: Client-Side Blob Reconstruction (Bypasses iframe download blocks)
  const handleClientSideBlobDownload = async () => {
    setDownloading(true);
    setDownloadError(null);
    setDownloadSuccess(false);

    try {
      // First attempt: fetch base64 endpoint for guaranteed iframe sandbox compliance
      const res = await fetch('/api/zip-base64');
      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!data.base64) {
        throw new Error('No base64 data returned from server');
      }

      // Convert base64 to binary ArrayBuffer
      const binaryString = window.atob(data.base64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Create Blob and trigger native browser save
      const blob = new Blob([bytes], { type: 'application/zip' });
      const blobUrl = window.URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = data.filename || 'crypto-scam-report-submitter.zip';
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setTimeout(() => {
        window.URL.revokeObjectURL(blobUrl);
      }, 5000);

      setDownloadSuccess(true);
    } catch (err: unknown) {
      console.warn('Base64 blob download failed, falling back to direct URL:', err);
      // Fallback: try direct blob fetch
      try {
        const fallbackRes = await fetch('/api/download-zip');
        const fallbackBlob = await fallbackRes.blob();
        const fallbackUrl = window.URL.createObjectURL(fallbackBlob);
        const link = document.createElement('a');
        link.href = fallbackUrl;
        link.download = 'crypto-scam-report-submitter.zip';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setDownloadSuccess(true);
      } catch (fallbackErr: unknown) {
        setDownloadError(fallbackErr instanceof Error ? fallbackErr.message : 'Direct browser download was blocked by container iframe.');
      }
    } finally {
      setDownloading(false);
    }
  };

  const copyToClipboard = (text: string, setter: (val: boolean) => void) => {
    navigator.clipboard.writeText(text);
    setter(true);
    setTimeout(() => setter(false), 2500);
  };

  return (
    <div
      id="zip-export-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fade-in"
    >
      <div className="bg-slate-900 border border-slate-700/80 rounded-xl shadow-2xl max-w-xl w-full p-6 text-slate-100 relative">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center">
              <FileArchive className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-100">Export Project ZIP</h2>
              <p className="text-xs text-slate-400">
                Multiple reliable methods to retrieve the full codebase archive
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body Options */}
        <div className="mt-5 space-y-4 text-xs">
          {/* Method 1: In-Browser Blob Save */}
          <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 hover:border-slate-700 transition-all">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-semibold text-slate-200 text-sm">Method 1: Direct In-Memory Save</span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                    Recommended
                  </span>
                </div>
                <p className="text-slate-400 text-xs leading-relaxed">
                  Downloads and unpacks the binary directly via JavaScript Blob memory, bypassing browser iframe download restrictions.
                </p>
              </div>
              <button
                onClick={handleClientSideBlobDownload}
                disabled={downloading}
                id="btn-blob-download"
                className="shrink-0 px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition-all shadow-md active:scale-95 disabled:opacity-50"
              >
                <Download className="w-4 h-4" />
                <span>{downloading ? 'Preparing...' : 'Save ZIP Now'}</span>
              </button>
            </div>

            {downloadSuccess && (
              <div className="mt-3 p-2.5 rounded-lg bg-emerald-950/50 border border-emerald-800 text-emerald-300 flex items-center gap-2 text-xs">
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>Archive generated successfully and sent to your browser downloads folder!</span>
              </div>
            )}

            {downloadError && (
              <div className="mt-3 p-2.5 rounded-lg bg-rose-950/50 border border-rose-800 text-rose-300 flex items-center gap-2 text-xs">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{downloadError} — Please use Method 2 or 3 below.</span>
              </div>
            )}
          </div>

          {/* Method 2: Open In Dedicated Window / New Tab */}
          <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 hover:border-slate-700 transition-all">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-semibold text-slate-200 text-sm mb-1">Method 2: Open in New Browser Tab</div>
                <p className="text-slate-400 text-xs leading-relaxed">
                  Opens the direct static file URL outside the iframe sandbox so your browser downloads it immediately.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={directDownloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  id="btn-open-tab-download"
                  className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-semibold text-xs flex items-center gap-1.5 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Open Tab</span>
                </a>
                <button
                  onClick={() => copyToClipboard(directDownloadUrl, setCopiedUrl)}
                  className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
                  title="Copy Direct URL"
                >
                  {copiedUrl ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
            <div className="mt-2.5 font-mono text-[11px] text-slate-400 bg-slate-900 px-3 py-1.5 rounded border border-slate-800 truncate select-all">
              {directDownloadUrl}
            </div>
          </div>

          {/* Method 3: Terminal Curl Command */}
          <div className="p-4 rounded-xl bg-slate-950/70 border border-slate-800 hover:border-slate-700 transition-all">
            <div className="flex items-start justify-between gap-4 mb-2">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-cyan-400" />
                <span className="font-semibold text-slate-200 text-sm">Method 3: Terminal / Curl Command</span>
              </div>
              <button
                onClick={() => copyToClipboard(curlCommand, setCopiedCurl)}
                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-[11px] font-medium flex items-center gap-1.5 transition-colors"
              >
                {copiedCurl ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3" />
                    <span>Copy Command</span>
                  </>
                )}
              </button>
            </div>
            <p className="text-slate-400 text-xs mb-2">
              Paste this command into your local terminal (macOS, Linux, or Windows Git Bash / WSL) to download directly:
            </p>
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-2.5 font-mono text-[11px] text-cyan-300 select-all overflow-x-auto">
              {curlCommand}
            </div>
          </div>

          {/* Method 4: AI Studio Native Export */}
          <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3">
            <HelpCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-200/90 leading-relaxed">
              <span className="font-semibold text-amber-300 block mb-0.5">Method 4: Google AI Studio Platform Export</span>
              You can also export this project natively without clicking any in-app buttons: look at the top-right corner of the Google AI Studio workspace, click the <strong className="text-amber-100 font-bold">⋮ (three dots / More options)</strong> menu, and select <strong className="text-amber-100 font-bold">Export to ZIP</strong> or <strong className="text-amber-100 font-bold">Export to GitHub</strong>.
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-5 pt-3 border-t border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
