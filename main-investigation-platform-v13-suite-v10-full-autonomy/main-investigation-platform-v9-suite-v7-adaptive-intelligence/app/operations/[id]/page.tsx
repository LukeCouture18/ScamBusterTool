import {OperationIntelligence} from '@/components/ops/operation-intelligence';
export default async function OperationPage({params}:{params:Promise<{id:string}>}) {return <main className="page-wrap"><OperationIntelligence operationId={(await params).id}/></main>;}
