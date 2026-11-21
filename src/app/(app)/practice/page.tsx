import { redirect } from "next/navigation";

/** Interview practice became Call prep's general practice (jobauto fork): the old address leads there. */
export default function PracticePage(): never {
  redirect("/call-prep");
}
