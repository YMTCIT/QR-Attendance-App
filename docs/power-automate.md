# Microsoft Forms / Power Automate integration

QR codes are created **outside** this application. The usual flow:

1. An attendee completes a **Microsoft Form**.
2. **Power Automate** receives the response and generates a unique code.
3. The registration is saved in Supabase through the `register-attendee` Edge Function.
4. The code is turned into a QR image and **emailed** to the attendee.
5. On event day, the tablet scans the emailed QR.

You need the `REGISTRATION_WEBHOOK_SECRET` from [README step 2.1e](../README.md#21-supabase).

---

## Flow, step by step

### ① Trigger
**Microsoft Forms › "When a new response is submitted"**: select your form.

### ② Get the answers
**Microsoft Forms › "Get response details"**: Form Id = your form; Response Id = *Response Id* from the trigger.

### ③ Generate the unique code
**"Initialize variable"**: Name `QrCode`, Type String, Value (expression):

```
concat('CIT-', toUpper(replace(guid(), '-', '')))
```

This gives an unguessable code such as `CIT-3F2A9C0E…`. Codes are compared as exact text after trimming. They don't have to be UUIDs.

### ④ Register in Supabase
**"HTTP" action** (premium connector):

- **Method:** `POST`
- **URI:** `https://<project-ref>.supabase.co/functions/v1/register-attendee`
- **Headers:**

  | Key | Value |
  |---|---|
  | `Content-Type` | `application/json` |
  | `x-registration-secret` | your `REGISTRATION_WEBHOOK_SECRET` |
  | `apikey` | your publishable (or anon) key. Lets the Supabase gateway route the call; it grants no data access. |

- **Body:**
  ```json
  {
    "qr_code": "@{variables('QrCode')}",
    "name": "@{outputs('Get_response_details')?['body/<full-name-question-id>']}",
    "id_number": "@{outputs('Get_response_details')?['body/<student-id-question-id>']}",
    "email": "@{outputs('Get_response_details')?['body/responder']}",
    "department": "@{outputs('Get_response_details')?['body/<department-question-id>']}",
    "event_id": 3
  }
  ```
  Insert the form answers with the dynamic-content picker; it fills in the `<…-question-id>` parts.
- **Settings → Retry policy:** *Exponential interval*, count 4.

**`event_id`:** the number in the **ID** column of **Dashboard → Events**. Use `null` (no quotes) to make the registrant valid for **any** event.

**Responses:** `200 {"status":"ok","id":…,"created":true|false}` · `400` validation errors (listed) · `401` wrong or missing secret · `422` unknown `event_id`.

### ⑤ Create the QR image and email it
- **HTTP** action: `GET https://quickchart.io/qr?size=400&margin=2&text=@{encodeUriComponent(variables('QrCode'))}`. Any QR image service works, including your institution's own. Note that this sends the code to that service.
- **Office 365 Outlook › "Send an email (V2)"** to the respondent: attach the image (Attachments Name `ticket.png`, Content = *Body* of the GET step), or embed it in HTML: `<img src="data:image/png;base64,@{base64(body('HTTP_GET_QR'))}" />`. Also include the code as text, as a manual fallback.
- Keep ④ **before** ⑤, and add a condition so the email is sent only when ④ returned status 200. That way nobody receives an unregistered QR code.

---

## Retries and duplicates

The code is generated **once** in step ③ and stored in a variable, so automatic retries of the HTTP action resend the same code. The function upserts on `qr_code`, so a retry updates the same registration instead of creating a duplicate.

> Do **not** use *Resubmit* on a run that already succeeded. It re-runs step ③, generates a *new* code, and creates a second registration. If that happens, delete the extra registrant in the dashboard.

---

## Without the premium HTTP connector

1. Keep steps ①–③ and ⑤. Add **Excel Online › "Add a row into a table"** that writes the **exact QR code** with the name, ID, email and department.
2. Before the event, download the Excel file and import it under **Dashboard → Registrants → Import Excel**. Re-importing later is safe: rows are matched on the QR code and check-ins are never touched.
