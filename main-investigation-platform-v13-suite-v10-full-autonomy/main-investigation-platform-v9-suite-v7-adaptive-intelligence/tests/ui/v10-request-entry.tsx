import {useState} from 'react';import {createRoot} from 'react-dom/client';
import {StartInvestigation} from '@/components/suite/autonomy';
import {useJson} from '@/components/suite/kit';import {SuiteContextProvider,useSuiteContext} from '@/components/suite/context';
function View(){const [url,setUrl]=useState<string|null>('/fixture/a');const {data,error,reload}=useJson<{value:string}>(url,100);const {ctx,set,clear,href}=useSuiteContext();
 return <><button onClick={()=>setUrl('/fixture/b')}>Switch B</button><button onClick={()=>setUrl('/fixture/slow')}>Slow</button><button onClick={()=>setUrl(null)}>Empty</button><button onClick={()=>void reload()}>Reload</button><p id="result">{data?.value??'loading'}</p><p id="error">{error}</p><p id="context">{JSON.stringify(ctx)}</p><a id="contextLink" href={href('/finder')}>Context link</a><button onClick={()=>set({site:'next.example',wallet:'ethereum:fixture'})}>Set context</button><button onClick={()=>clear()}>Clear context</button></>;
}
createRoot(document.getElementById('root')!).render(<SuiteContextProvider><View/><StartInvestigation/></SuiteContextProvider>);
