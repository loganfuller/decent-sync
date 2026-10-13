import { useParams } from "react-router";
import { EquipmentDetails } from "@/components/equipment";

/** One Basket: what it is, the Locations showing it, which can be changed there, its Conflicts and its history. */
export function BasketPage() {
  const { id = "" } = useParams();
  return <EquipmentDetails key={id} kind="basket" id={id} />;
}
