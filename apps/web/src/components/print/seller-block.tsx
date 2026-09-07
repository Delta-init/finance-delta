import { formatOrgAddress, taxNumberLabel, type OrganizationSettings } from "@delta/shared";

/**
 * Who issued this document, printed under the logo.
 *
 * An invoice without the issuer's address and registration is not a document a
 * client can file — it is a note saying what they owe. Everything here is
 * optional, and a line the organization has not filled in is left out rather
 * than printed as an empty heading, so an organization set up before Settings
 * asked for any of it looks exactly as it did.
 */
export function PrintSellerBlock({ org }: { org?: OrganizationSettings | null }) {
  if (!org) return null;

  const lines = formatOrgAddress(org.address);
  const registeredLines = formatOrgAddress(org.registeredAddress);
  const contact = [org.phone, org.email, org.website].filter((v) => (v ?? "").trim().length > 0);
  const regLabel = taxNumberLabel(org.taxSystem);
  const name = org.legalName?.trim() || org.name;

  if (lines.length === 0 && registeredLines.length === 0 && contact.length === 0 && !org.taxRegistrationNumber) {
    // Nothing worth a block: the logo already says who this is.
    return null;
  }

  return (
    <div style={{ marginTop: 10, fontSize: 11, color: "#475569", lineHeight: 1.5 }}>
      <div style={{ fontWeight: 600, fontSize: 12, color: "#111" }}>{name}</div>
      {lines.map((l) => (
        <div key={l}>{l}</div>
      ))}
      {contact.length > 0 && <div>{contact.join("  ·  ")}</div>}
      {org.taxRegistrationNumber && (
        <div style={{ marginTop: 2 }}>
          <span style={{ color: "#64748b" }}>{regLabel}: </span>
          <span style={{ fontWeight: 600, color: "#111" }}>{org.taxRegistrationNumber}</span>
        </div>
      )}
      {org.registrationNumber && (
        <div>
          <span style={{ color: "#64748b" }}>Reg. no: </span>
          <span style={{ fontWeight: 500, color: "#111" }}>{org.registrationNumber}</span>
        </div>
      )}
      {/* The registered office, where it is not the address above. Indian
          invoices print both; an organization with one address has nothing
          here and the block does not appear. */}
      {registeredLines.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ color: "#64748b" }}>{org.registeredAddressLabel?.trim() || "Registered office"}</div>
          {registeredLines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}
