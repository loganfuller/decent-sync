import { EquipmentList } from "@/components/equipment";

/** The Library's Baskets and the Locations showing each, filtered. Baskets join the Library from tablets, or are created here. */
export function BasketsPage() {
  return (
    <EquipmentList
      kind="basket"
      title="Baskets"
      description="DYE2's baskets, one item for each model of basket at every Location, shown or hidden at each. A Basket saved in DYE2 on a tablet joins the Library shown at that tablet's Location only, or becomes the Basket of the same name already there, and is written to every tablet there. A Basket a Location does not show is removed from its tablets' DYE2 lists."
    />
  );
}
