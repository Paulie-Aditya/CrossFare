# Why Arkiv

A quote from a swap API is normally a private promise: the caller has only the API's word for what it offered.

**A database wouldn't solve this.** A quote in our own database is only as trustworthy as our server, because we could edit it afterwards.

**Arkiv fits for three reasons:**

- **Anyone can read it without asking us.** An agent, its owner or a third party can query a quote directly.
- **Changes are visible.** Each update is an on-chain transaction under Crossfare's wallet, not a silent edit.
- **Expiry is built in.** A quote is short-lived data, and entities that expire when the quote does mean no cleanup job and no permanent storage for something useful for minutes.

Over time, keeping quoted and received amounts side by side can build a public accuracy record per venue.
