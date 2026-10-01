import json
from pathlib import Path
from datetime import datetime
from decimal import Decimal

SOURCE = Path("uploads/ter-travel-entries.json")
OUTPUT = Path("database/migrations/002_migrate_ter_entries.sql")

data = json.loads(SOURCE.read_text(encoding="utf-8"))

def sql_text(value):
    if value is None:
        return "NULL"
    s = str(value)
    return "'" + s.replace("'", "''") + "'"

def money(value):
    s = str(value or "").replace(",", "").strip()
    return str(Decimal(s) if s else Decimal("0"))

statements = []

for row in data:
    entry_id = str(row["id"]).strip()
    ter_id = str(row["terId"]).strip()

    transaction_date = datetime.strptime(
        str(row["transactionDate"]).strip(),
        "%B %d, %Y"
    ).date().isoformat()

    created_at = datetime.fromisoformat(
        str(row["createdAt"]).replace("Z", "+00:00")
    ).isoformat()

    updated_at = datetime.fromisoformat(
        str(row["updatedAt"]).replace("Z", "+00:00")
    ).isoformat()

    statement = f"""
INSERT INTO travel_entries (
    id,
    travel_report_id,
    ter_id,
    source_name,
    transaction_date,
    transaction_time,
    origin,
    destination,
    mode_of_transportation,
    amount,
    per_diem,
    breakfast,
    lunch,
    dinner,
    others,
    remarks,
    notes,
    ticket_file_name,
    ticket_mime_type,
    ticket_storage_path,
    created_at,
    updated_at
)
VALUES (
    {sql_text(entry_id)},
    NULL,
    {sql_text(ter_id)},
    {sql_text(row.get("sourceName"))},
    {sql_text(transaction_date)},
    {sql_text(row.get("time"))},
    {sql_text(row.get("from"))},
    {sql_text(row.get("to"))},
    {sql_text(row.get("modeOfTransportation"))},
    {money(row.get("amount"))},
    {money(row.get("perDiem"))},
    {money(row.get("breakfast"))},
    {money(row.get("lunch"))},
    {money(row.get("dinner"))},
    {money(row.get("others"))},
    {sql_text(row.get("remarks"))},
    {sql_text(row.get("notes"))},
    {sql_text(row.get("ticketFileName"))},
    {sql_text(row.get("ticketMimeType"))},
    NULL,
    {sql_text(created_at)},
    {sql_text(updated_at)}
)
ON CONFLICT (id) DO NOTHING;
""".strip()

    statements.append(statement)

sql = (
    "BEGIN;\n\n"
    + "\n\n".join(statements)
    + "\n\nCOMMIT;\n"
)

OUTPUT.write_text(sql, encoding="utf-8")

print("Migration file created:", OUTPUT)
print("Source records:", len(data))
print("INSERT statements:", len(statements))
print("Database changes made: NO")
