/* Inline stroke icons (24×24). Static strings only — never user input. */
const PATHS: Record<string, string> = {
  // category icons
  food: '<path d="M4 12h16a8 8 0 0 1-16 0Z"/><path d="M9 4.5c-.8.9-.8 2.1 0 3M12.5 4.5c-.8.9-.8 2.1 0 3M16 4.5c-.8.9-.8 2.1 0 3"/>',
  coffee: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5Z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16M8.5 3.5c-.6.8-.6 1.7 0 2.5M12 3.5c-.6.8-.6 1.7 0 2.5"/>',
  transport: '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 10h14M8.5 21l1.5-4M15.5 21 14 17M9 13.5h.01M15 13.5h.01"/>',
  car: '<path d="M5 16.5V12l1.8-4.4A2 2 0 0 1 8.7 6.3h6.6a2 2 0 0 1 1.9 1.3L19 12v4.5"/><path d="M3.5 12h17v4.5h-17ZM7 16.5V19M17 16.5V19M7.5 14.2h.01M16.5 14.2h.01"/>',
  plane: '<path d="M21 4.5 3.5 11l6.5 2.5L12.5 20Z"/><path d="m10 13.5 4-4"/>',
  daily: '<path d="M3.5 9.5h17l-1.6 9.1a2 2 0 0 1-2 1.6H7.1a2 2 0 0 1-2-1.6Z"/><path d="m8 9.5 4-5.5 4 5.5"/>',
  shopping: '<path d="M5.5 7.5h13l1 12.5h-15Z"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/>',
  shirt: '<path d="M8.5 4 4 6.5l1.5 4 2-.8V20h9V9.7l2 .8 1.5-4L15.5 4a3.5 3.5 0 0 1-7 0Z"/>',
  fun: '<circle cx="12" cy="12" r="8.5"/><path d="M10.2 8.8v6.4l5.3-3.2Z"/>',
  home: '<path d="m4 11 8-6.5 8 6.5"/><path d="M6.5 9.5v10h11v-10M10.5 19.5v-5h3v5"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 17.5h2"/>',
  medical: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/>',
  pet: '<circle cx="7" cy="10" r="1.6"/><circle cx="10.2" cy="6.5" r="1.6"/><circle cx="13.8" cy="6.5" r="1.6"/><circle cx="17" cy="10" r="1.6"/><path d="M12 12c-2.6 0-5 3.2-5 5.3 0 1.4 1 2.2 2.4 2.2.9 0 1.6-.5 2.6-.5s1.7.5 2.6.5c1.4 0 2.4-.8 2.4-2.2 0-2.1-2.4-5.3-5-5.3Z"/>',
  book: '<path d="M5 4.5h10a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3Z"/><path d="M5 17a3 3 0 0 1 3-3h10"/>',
  gift: '<rect x="4.5" y="10" width="15" height="10" rx="1.5"/><path d="M3.5 7h17v3h-17ZM12 7v13M12 7c-1.5-3-5-2.8-4.4-.7M12 7c1.5-3 5-2.8 4.4-.7"/>',
  invest: '<path d="M4 19.5h16"/><path d="m5 15 4.5-4.5 3.5 3 6-6.5"/><path d="M15 7h4v4"/>',
  other: '<circle cx="6.5" cy="12" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="17.5" cy="12" r="1.1"/>',
  salary: '<rect x="3.5" y="7" width="17" height="12" rx="2.5"/><path d="M9 7V5.5h6V7M3.5 12.5h17"/>',
  bonus: '<rect x="4.5" y="10" width="15" height="10" rx="1.5"/><path d="M3.5 7h17v3h-17ZM12 7v13M12 7c-1.5-3-5-2.8-4.4-.7M12 7c1.5-3 5-2.8 4.4-.7"/>',
  plusCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M8.5 12h7"/>',
  // interface icons
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  left: '<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>',
  right: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
  chev: '<path d="m9.5 6 6 6-6 6"/>',
  tabHome: '<path d="M4 10.5 12 4l8 6.5V20H4Z"/><path d="M10 20v-5.5h4V20"/>',
  tabList: '<path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
  tabStats: '<path d="M5.5 20v-7M12 20V5M18.5 20v-10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  backspace: '<path d="M20 6H9.5L4 12l5.5 6H20Z"/><path d="m11.5 9.5 5 5M16.5 9.5l-5 5"/>',
  trash: '<path d="M4.5 7h15M10 4h4M6.5 7l1 12.5h9l1-12.5"/>',
  cal: '<rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  card: '<rect x="3.5" y="6" width="17" height="12" rx="2.5"/><path d="M3.5 10h17"/>',
  note: '<path d="M5 5h14v10l-4 4H5Z"/><path d="M15 19v-4h4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.3h.01"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  filter: '<path d="M4 7h16M7 12h10M10 17h4"/>',
  inbox: '<path d="M4 13.5 6.5 5h11L20 13.5V19H4Z"/><path d="M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20"/>',
  doc: '<path d="M6.5 3.5h7.5l4 4V20.5h-11.5Z"/><path d="M13.5 3.5v4.5h4.5M9.5 12.5h5M9.5 16h5"/>',
  reconcile: '<rect x="3.5" y="6" width="17" height="12" rx="2.5"/><path d="M3.5 10h17M8 14.5l1.8 1.8 3.4-3.6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  receipt: '<path d="M6 3.5h12v17l-2.5-1.5-2 1.5-1.5-1.5-1.5 1.5-2-1.5L6 20.5Z"/><path d="M9 8h6M9 11.5h6M9 15h4"/>',
  // accounts (D-123)
  wallet: '<path d="M4.5 7.5A2.5 2.5 0 0 1 7 5h11v3"/><rect x="4.5" y="8" width="15" height="11" rx="2.5"/><path d="M15.5 13.5H17"/>',
  swap: '<path d="M7 7.5h11l-3-3M17 16.5H6l3 3"/>',
  bank: '<path d="m4 10 8-5 8 5M6 10v7M10 10v7M14 10v7M18 10v7M4 19.5h16"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.5c-.5-.9-1.4-1.3-2.5-1.3-1.5 0-2.5.8-2.5 1.9 0 2.6 5 1.3 5 3.9 0 1.1-1 1.9-2.5 1.9-1.2 0-2.1-.5-2.6-1.4M12 7v1.2M12 15.8V17"/>',
  adjust: '<path d="M5 7h9M18 7h1M5 17h3M12 17h7"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  up: '<path d="m6 14.5 6-6 6 6"/>',
  down: '<path d="m6 9.5 6 6 6-6"/>',
  out: '<path d="M12 19V7M7 12l5-5 5 5"/>',
}

/** D-12: icons offered when creating a category. */
export const CATEGORY_ICON_CHOICES = [
  'food', 'coffee', 'transport', 'car', 'plane', 'daily', 'shopping', 'shirt',
  'fun', 'home', 'phone', 'medical', 'pet', 'book', 'gift', 'invest',
] as const

export const ICON_LABELS: Record<string, string> = {
  food: '餐點', coffee: '咖啡', transport: '大眾運輸', car: '汽車', plane: '旅行', daily: '日用品',
  shopping: '購物袋', shirt: '衣服', fun: '娛樂', home: '居家', phone: '手機', medical: '醫療',
  pet: '寵物', book: '書本', gift: '禮物', invest: '投資',
}

export function Icon({ name, className }: { name: string; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: PATHS[name] ?? PATHS.other }}
    />
  )
}
