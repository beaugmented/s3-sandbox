/** UTC ISO 8601 timestamp with exactly three fractional digits, as in pack-os. */
export type Iso8601 = string & { __brand: "ISO8601" }

export function iso8601FromInstant(instant: Temporal.Instant): Iso8601
export function iso8601FromInstant(
	instant: Temporal.Instant | null,
): Iso8601 | null
export function iso8601FromInstant(
	instant: Temporal.Instant | null,
): Iso8601 | null {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This constructor brands Temporal's canonical UTC millisecond output.
	return (instant?.toString({ smallestUnit: "millisecond" }) as Iso8601) ?? null
}

export function instantFromISO8601(isoString: Iso8601): Temporal.Instant
export function instantFromISO8601(
	isoString: Iso8601 | null,
): Temporal.Instant | null
export function instantFromISO8601(
	isoString: Iso8601 | null,
): Temporal.Instant | null {
	return isoString === null ? null : Temporal.Instant.from(isoString)
}

export function isoNow(): Iso8601 {
	return iso8601FromInstant(Temporal.Now.instant())
}

const months = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
]
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

/** HTTP timestamps use IMF-fixdate and always describe UTC, with second precision. */
export function toHttpDate(instant: Temporal.Instant): string {
	const utc = instant.toZonedDateTimeISO("UTC")
	return `${weekdays[utc.dayOfWeek - 1]}, ${pad(utc.day)} ${months[utc.month - 1]} ${String(utc.year).padStart(4, "0")} ${pad(utc.hour)}:${pad(utc.minute)}:${pad(utc.second)} GMT`
}

/** Parse the compact AWS signing timestamp; invalid input has no instant. */
export function parseISO8601String(value: string): Temporal.Instant | null {
	if (!/^\d{8}T\d{6}Z$/.test(value)) return null
	try {
		return Temporal.Instant.from(
			`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`,
		)
	} catch {
		return null
	}
}

/** Parse IMF-fixdate and the two obsolete HTTP formats required by RFC 9110. */
export function parseHttpDate(value: string): Temporal.Instant | null {
	let match =
		/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
			value,
		)
	let year: number
	let day: number
	let month: string
	let hour: number
	let minute: number
	let second: number
	if (match) {
		day = Number(match[1])
		month = match[2]!
		year = Number(match[3])
		hour = Number(match[4])
		minute = Number(match[5])
		second = Number(match[6])
	} else {
		match =
			/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(\w{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
				value,
			)
		if (match) {
			day = Number(match[1])
			month = match[2]!
			year = Number(match[3])
			hour = Number(match[4])
			minute = Number(match[5])
			second = Number(match[6])
			const currentYear = Temporal.Now.instant().toZonedDateTimeISO("UTC").year
			year += Math.floor(currentYear / 100) * 100
			if (year > currentYear + 50) year -= 100
		} else {
			match =
				/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\w{3}) ( [1-9]|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(
					value,
				)
			if (!match) return null
			month = match[1]!
			day = Number(match[2])
			hour = Number(match[3])
			minute = Number(match[4])
			second = Number(match[5])
			year = Number(match[6])
		}
	}
	try {
		return Temporal.ZonedDateTime.from(
			{
				year,
				month: months.indexOf(month) + 1,
				day,
				hour,
				minute,
				second,
				timeZone: "UTC",
			},
			{ overflow: "reject" },
		).toInstant()
	} catch {
		return null
	}
}

/** Accept ISO timestamps, AWS signing timestamps, and HTTP dates at protocol boundaries. */
export function parseDate(value: string): Temporal.Instant | null {
	if (typeof value !== "string") return null
	try {
		return Temporal.Instant.from(value)
	} catch {
		return parseISO8601String(value) ?? parseHttpDate(value)
	}
}

/** Format the compact AWS signing timestamp without separators or fractions. */
export function toISO8601String(instant: Temporal.Instant): string {
	return instant.toString({ smallestUnit: "second" }).replace(/[-:]/g, "")
}

function pad(value: number): string {
	return String(value).padStart(2, "0")
}
