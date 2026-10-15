import "react-cmdk/dist/cmdk.css"
import CommandPalette, { filterItems, getItemIndex, useHandleOpenCommandPalette } from "react-cmdk"
import { useState, useEffect } from "react"

let _setOpen = null
/** Open the command palette from anywhere (e.g. the top bar button). */
export function openCommandPalette() { _setOpen?.(true) }

/** ⌘K command palette for navigating between pages. */
export default function AppCommandPalette({ setActive }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")

  useEffect(() => { _setOpen = setOpen; return () => { _setOpen = null } }, [])
  useHandleOpenCommandPalette(setOpen)

  const filteredItems = filterItems(
    [
      {
        heading: "Navigation",
        id: "nav",
        items: [
          { id: "dashboard", children: "Tableau de bord",  icon: "HomeIcon",              onClick: () => setActive("dashboard") },
          { id: "clients",   children: "Clients",          icon: "UsersIcon",             onClick: () => setActive("clients") },
          { id: "tx",        children: "Transactions",     icon: "CreditCardIcon",        onClick: () => setActive("tx") },
          { id: "objectifs", children: "Objectifs",        icon: "FlagIcon",              onClick: () => setActive("objectifs") },
          { id: "produits",  children: "Produits",         icon: "CubeIcon",              onClick: () => setActive("produits") },
          { id: "reconciliation", children: "Réconciliation", icon: "CalculatorIcon",       onClick: () => setActive("reconciliation") },
          { id: "agents",    children: "Agents & TPE",     icon: "DevicePhoneMobileIcon", onClick: () => setActive("agents") },
          { id: "settings",  children: "Paramètres",       icon: "CogIcon",               onClick: () => setActive("settings") },
        ],
      },
    ],
    search
  )

  return (
    <CommandPalette
      onChangeSearch={setSearch}
      onChangeOpen={setOpen}
      search={search}
      isOpen={open}
      placeholder="Rechercher…"
    >
      <CommandPalette.Page id="root">
        {filteredItems.length ? (
          filteredItems.map((list) => (
            <CommandPalette.List key={list.id} heading={list.heading}>
              {list.items.map(({ id, ...rest }) => (
                <CommandPalette.ListItem
                  key={id}
                  index={getItemIndex(filteredItems, id)}
                  {...rest}
                />
              ))}
            </CommandPalette.List>
          ))
        ) : (
          <CommandPalette.FreeSearchAction />
        )}
      </CommandPalette.Page>
    </CommandPalette>
  )
}
