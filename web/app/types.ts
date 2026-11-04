export type Tracked = {value: string | null; status: string};
export type Recipe = {
  id: string; title: Tracked; revision: number;
  materials: {id: string; material_name: Tracked; quantity: Tracked; unit: string | null;
    price_override?: {amount_jpy: Tracked; per_quantity: string; per_unit: string} | null;
    price_mode: string; unit_id?: string | null; ingredient_id?: string | null; supplier_id?: string | null; supplier_name?: string | null; offer_id?: string | null;
    effective_price?: {amount_jpy: Tracked; per_quantity: string; per_unit: string} | null}[];
  selling_price_jpy: Tracked;
  display_names?: Record<string, {display: string; material: string}>;
};
export type Operation = Record<string, string>;
export type AIProposal = {recipe_id: string; base_revision: number; operations: Operation[]; requires_confirmation: true;
  provider?: {name: string; model: string} | null};
// Only idempotent reads may retry while the free backend resumes from sleep.
// Never retry POST: an ambiguous response may already have committed a mutation.
export async function startupRead<T>(path: string, onWaiting: () => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request<T>(path);
    } catch (error) {
      const status = error instanceof Error ? error.message : "";
      if (!["502", "503", "504"].includes(status) || attempt >= 7) throw error;
      onWaiting();
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {...init, headers: {"Content-Type": "application/json"}, cache: "no-store"});
  if (!response.ok){let data:{error?:unknown}={};try{data=await response.json();}catch{}
    throw Object.assign(new Error(String(response.status)),{code:data.error});
  }
  return response.json();
}
