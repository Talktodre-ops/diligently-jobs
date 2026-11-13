const words = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']

/** "Two" for 2, "11" past ten. Capitalised, for the start of a sentence. */
export function countWord(n: number) {
  return words[n] ?? String(n)
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

/** "Morning", "Afternoon" or "Evening" for the local hour. */
export function greeting(now = new Date()) {
  const h = now.getHours()
  if (h < 12) return 'Morning'
  if (h < 18) return 'Afternoon'
  return 'Evening'
}

const DAY = 86_400_000

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** "Today", "Yesterday", "Monday", or "3 Nov" for anything older than a week. */
export function dayLabel(iso: string, now = new Date()) {
  const d = new Date(iso)
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / DAY)
  if (diff <= 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff < 7) return d.toLocaleDateString('en-GB', { weekday: 'long' })
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** "today", "2 days ago", "in 3 days" for a due date. */
export function dueLabel(iso: string, now = new Date()) {
  const diff = Math.round((startOfDay(new Date(iso)) - startOfDay(now)) / DAY)
  if (diff === 0) return 'due today'
  if (diff < 0) return diff === -1 ? 'due yesterday' : `due ${-diff} days ago`
  return diff === 1 ? 'due tomorrow' : `due in ${diff} days`
}
