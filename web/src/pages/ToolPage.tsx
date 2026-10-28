import { useParams } from "react-router";
import { EquipmentDetails } from "@/components/equipment";

/** One Tool: what it is, the Locations showing it, which can be changed there, its Conflicts and its history. */
export function ToolPage() {
  const { id = "" } = useParams();
  return <EquipmentDetails key={id} kind="tool" id={id} />;
}
