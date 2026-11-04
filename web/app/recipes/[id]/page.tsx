"use client";
import RecipeController from "../../RecipeController";

// Separate Next.js route. URL owns the recipe identity; the shared
// controller retains the existing authenticated CRUD + Human Gate path.
export default function RecipeDetailPage(){
 return <RecipeController pageKind="detail"/>;
}
