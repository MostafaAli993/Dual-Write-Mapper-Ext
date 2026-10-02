// Fixture modelled on the real mismatch Mostafa hit: label "Not submitted" -> name "Draft",
// label "Rejected" -> name "Denied".
export const fnoEnum = {
  name: 'ARQ_QuoteApprovalStatus',
  label: 'Quote approval status',
  members: [
    { name: 'Draft',     value: 0, labelId: '@SYS1001', label: 'Not submitted' },
    { name: 'Submitted', value: 1, labelId: '@SYS1002', label: 'Submitted' },
    { name: 'Approved',  value: 2, labelId: '@SYS1003', label: 'Approved' },
    { name: 'Denied',    value: 3, labelId: '@SYS1004', label: 'Rejected' },
    { name: 'Cancelled', value: 4, labelId: '@SYS1005', label: 'Cancelled' },
    { name: 'Expired',   value: 5, labelId: '@SYS1006', label: 'Expired' }
  ]
};

export const dvColumn = {
  tableLogicalName: 'arq_quote',
  logicalName: 'arq_approvalstatus',
  displayName: 'Approval Status',
  options: [
    { value: 750880000, label: 'Not Submitted' },
    { value: 750880001, label: 'Submitted' },
    { value: 750880002, label: 'Approved' },
    { value: 750880003, label: 'Rejected' },
    { value: 750880004, label: 'Cancelled' },
    { value: 750880005, label: 'On hold' }
  ]
};
