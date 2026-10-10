import React from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, Info, XCircle } from 'lucide-react';
import { CompletenessDetails, DataCompleteness } from '../types';

interface DataQualityBannerProps {
  completeness: DataCompleteness;
  details?: CompletenessDetails;
  network?: string;
}

export const DataQualityBanner: React.FC<DataQualityBannerProps> = ({
  completeness,
  details,
  network,
}) => {
  if (completeness === 'COMPLETE') {
    return (
      <div id="data-quality-complete-banner" className="flex items-center gap-3 bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 px-4 py-2.5 rounded-lg text-sm">
        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
        <div>
          <span className="font-semibold text-emerald-200">Data Completeness: COMPLETE</span>
          <span className="text-emerald-400/80 ml-2">
            Verified full transaction history retrieved across available blocks on {network || 'blockchain'}.
          </span>
        </div>
      </div>
    );
  }

  if (completeness === 'PARTIAL') {
    return (
      <div id="data-quality-partial-banner" className="flex items-start gap-3 bg-amber-950/40 border border-amber-500/40 text-amber-300 px-4 py-3 rounded-lg text-sm">
        <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold uppercase tracking-wider text-xs px-2 py-0.5 bg-amber-500/20 rounded border border-amber-500/30 text-amber-300">
              Data Completeness: PARTIAL
            </span>
            <span className="text-amber-200 font-medium">Dataset is incomplete due to provider boundaries</span>
          </div>
          <p className="text-amber-300/80 text-xs leading-relaxed">
            {details?.warning_message ||
              `The provider returned a limited slice of activity (${details?.records_retrieved ?? 'partial'} records over ${details?.pages_retrieved ?? 1} page). Earliest history may be missing. Financial sums and transaction counts do NOT represent total lifetime wallet activity.`}
          </p>
        </div>
      </div>
    );
  }

  if (completeness === 'LIMITED') {
    return (
      <div id="data-quality-limited-banner" className="flex items-start gap-3 bg-blue-950/40 border border-blue-500/40 text-blue-300 px-4 py-2.5 rounded-lg text-sm">
        <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
        <div>
          <span className="font-semibold text-blue-200">Data Completeness: LIMITED</span>
          <span className="text-blue-300/80 ml-2">
            Analysis was restricted by configured investigation budget limits (hop depth or wallet count limit).
          </span>
        </div>
      </div>
    );
  }

  if (completeness === 'FAILED') {
    return (
      <div id="data-quality-failed-banner" className="flex items-start gap-3 bg-rose-950/40 border border-rose-500/40 text-rose-300 px-4 py-2.5 rounded-lg text-sm">
        <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
        <div>
          <span className="font-semibold text-rose-200">Data Completeness: FAILED</span>
          <span className="text-rose-300/80 ml-2">
            Failed retrieving data from all registered providers. Check provider health or rate limits.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div id="data-quality-unknown-banner" className="flex items-center gap-3 bg-slate-800 border border-slate-700 text-slate-300 px-4 py-2 rounded-lg text-sm">
      <HelpCircle className="w-4 h-4 text-slate-400 shrink-0" />
      <span>Data Completeness: UNKNOWN (Analysis pending or unperformed)</span>
    </div>
  );
};
