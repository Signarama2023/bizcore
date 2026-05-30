import BankAccounts from '../components/BankAccounts'
import PayrollPanel from '../components/PayrollPanel'

/**
 * Finance page — money in / money out for a Profit-First-run small
 * business. The two canonical data sources both live here:
 *
 *   1. BankAccounts (BankSync / Plaid)  →  what actually hit the bank
 *   2. PayrollPanel (Gusto API or any-provider PDF/CSV upload)
 *                                       →  labor cost, the single
 *                                          biggest controllable expense
 *
 * STRIP-01..03 (2026-05-23): the v0 manual paths have been removed —
 *   - "Sales History" CSV/XLSX uploader → Corebridge Pipeline is the
 *     canonical sales source now (the Pipeline page)
 *   - "QuickBooks workbook" XLSX uploader (Document Overview, KPI
 *     tiles, AI analysis on the imported file) → bank + payroll
 *     together cover what the QB workbook used to provide
 *   - "Weekly Log" manual entry form → bank deposits + Corebridge
 *     sales + Gusto payroll cover the same fields it captured
 *
 * What used to live here as ~550 lines of file-import handlers, sheet
 * pickers, row pickers, drag-drop overlays, and ad-hoc AI analysis
 * has been replaced by two live integrations. The Evaluation page is
 * where any AI synthesis happens now — it reads from the canonical
 * server tables that BankAccounts and PayrollPanel write to.
 *
 * If you need historical sales analysis from a CSV: import it into
 * Corebridge (it's the system of record) and re-sync the Pipeline.
 * The product surface here intentionally narrows to the trinity:
 * Corebridge for sales, Bank for cash, Payroll for labor.
 */
export default function Finance() {
  return (
    <div>
      <h1 className="page-title">Finance</h1>
      <p className="page-subtitle">
        Cash in / cash out, plus labor cost — the two halves of the operating story. Bank transactions
        come from BankSync (Plaid). Payroll comes from Gusto if connected, or from any provider via
        Payroll Journal upload. Sales live on the Pipeline page (Corebridge).
      </p>

      <BankAccounts />

      <PayrollPanel />
    </div>
  )
}
