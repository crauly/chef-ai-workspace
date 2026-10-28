export type Tracked = {value: string | null; status: string};
export type Recipe = {
  id: string; title: Tracked; revision: number;
  materials: {id: string; material_name: Tracked; quantity: Tracked; unit: string | null;
    price_override?: {amount_jpy: Tracked; per_quantity: string; per_unit: string} | null;
    price_mode: string}[];
  selling_price_jpy: Tracked;
};
export type Operation = Record<string, string>;
export type AIProposal = {recipe_id: string; base_revision: number; operations: Operation[]; requires_confirmation: true;
  provider?: {name: string; model: string} | null};
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {...init, headers: {"Content-Type": "application/json"}, cache: "no-store"});
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}
