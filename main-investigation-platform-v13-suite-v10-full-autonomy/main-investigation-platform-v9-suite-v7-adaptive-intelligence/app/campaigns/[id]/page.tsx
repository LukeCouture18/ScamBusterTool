import { CampaignWorkspace } from "@/components/ops/campaign-workspace";
export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main className="page-wrap"><CampaignWorkspace campaignId={id} /></main>;
}
