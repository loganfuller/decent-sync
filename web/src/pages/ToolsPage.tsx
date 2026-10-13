import { EquipmentList } from "@/components/equipment";

/** The Library's Tools and the Locations showing each, filtered. Tools join the Library from tablets, or are created here. */
export function ToolsPage() {
  return (
    <EquipmentList
      kind="tool"
      title="Tools"
      description="Gear such as WDT tools and puck screens, which DYE2 calls equipment, each one item at every Location, shown or hidden at each. A Tool saved in DYE2 on a tablet joins the Library shown at that tablet's Location only, or becomes the Tool of the same name already there, and is written to every tablet there. Deleting it in DYE2 hides it at that tablet's Location only; a Tool a Location does not show is removed from its tablets' DYE2 lists."
    />
  );
}
