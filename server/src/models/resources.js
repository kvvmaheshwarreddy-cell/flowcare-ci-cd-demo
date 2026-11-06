// Hospital resource inventory collections (PRD extension, sections 14-18).
const mongoose = require('mongoose');
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

const ResourceCategory = model(
  'ResourceCategory',
  new Schema({
    code: { type: String, required: true, unique: true, lowercase: true },
    name: { type: String, required: true },
    description: String,
    tracking: { type: String, enum: ['quantity', 'asset', 'capacity'], default: 'quantity' },
  }),
  'resourceCategories',
);

const InventoryItem = model(
  'InventoryItem',
  new Schema(
    {
      sku: { type: String, required: true, unique: true, uppercase: true, trim: true },
      name: { type: String, required: true, trim: true },
      category: { type: String, required: true, lowercase: true }, // ResourceCategory.code
      unit: { type: String, required: true }, // e.g. vial, bag, box, piece
      department: { type: ObjectId, ref: 'Department' },
      criticality: { type: String, enum: ['essential', 'important', 'routine'], default: 'important' },
      reorderThreshold: { type: Number, min: 0, default: 0 },
      safetyStock: { type: Number, min: 0, default: 0 },
      leadTimeDays: { type: Number, min: 0, default: 7 },
      reservedQuantity: { type: Number, min: 0, default: 0 },
      trackBatches: { type: Boolean, default: true },
      restricted: { type: Boolean, default: false }, // e.g. controlled medicines
      supplier: String,
      // Medicine-specific metadata (medicineInventory). Clinical decisions stay outside the engine.
      medicine: { genericName: String, strength: String, form: String, storage: String },
    },
    { timestamps: true },
  ),
  'inventoryItems',
);

const batchSchema = new Schema(
  {
    item: { type: ObjectId, ref: 'InventoryItem', required: true },
    batchNo: { type: String, required: true },
    quantity: { type: Number, required: true, min: [0, 'Inventory cannot be negative'] },
    status: { type: String, enum: ['usable', 'quarantined', 'damaged', 'expired'], default: 'usable' },
    expiryDate: Date,
    location: { type: String, default: 'Main store' },
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
batchSchema.index({ item: 1, batchNo: 1, location: 1 }, { unique: true });
const InventoryBatch = model('InventoryBatch', batchSchema, 'inventoryBatches');

const txnSchema = new Schema({
  txnId: { type: String, required: true, unique: true },
  item: { type: ObjectId, ref: 'InventoryItem', required: true },
  type: { type: String, enum: ['receipt', 'issue', 'transfer', 'adjustment', 'status_change'], required: true },
  quantity: { type: Number, required: true }, // signed for adjustments, positive otherwise
  unit: { type: String, required: true },
  batch: { type: ObjectId, ref: 'InventoryBatch' },
  batchNo: String,
  sourceLocation: String,
  destinationLocation: String,
  department: { type: ObjectId, ref: 'Department' },
  user: { type: ObjectId, ref: 'User' },
  userName: String,
  reason: { type: String, default: '' },
  reference: String, // purchase order / request number
  timestamp: { type: Date, default: Date.now },
});
// Inventory history is append-only: block every update and delete path.
const immutable = function () {
  throw new Error('Inventory transactions are append-only and cannot be modified or deleted');
};
['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'].forEach((op) =>
  txnSchema.pre(op, immutable),
);
txnSchema.pre('save', function (next) {
  if (!this.isNew) return next(new Error('Inventory transactions are append-only and cannot be modified'));
  next();
});
const InventoryTransaction = model('InventoryTransaction', txnSchema, 'inventoryTransactions');

const OxygenCylinder = model(
  'OxygenCylinder',
  new Schema(
    {
      cylinderId: { type: String, required: true, unique: true, uppercase: true },
      size: { type: String, enum: ['B', 'D', 'E', 'F', 'H'], default: 'D' },
      capacityLiters: { type: Number, required: true, min: 1 },
      status: {
        type: String,
        enum: ['full', 'in_use', 'empty', 'refilling', 'maintenance', 'quarantined'],
        default: 'full',
      },
      location: { type: String, required: true },
      department: { type: ObjectId, ref: 'Department' },
      lastInspection: Date,
      nextInspectionDue: Date,
    },
    { timestamps: true },
  ),
  'oxygenCylinders',
);

const OxygenMeasurement = model(
  'OxygenMeasurement',
  new Schema({
    source: { type: String, enum: ['central_tank', 'manifold', 'concentrator'], required: true },
    sourceName: { type: String, required: true },
    department: { type: ObjectId, ref: 'Department' },
    litersRemaining: { type: Number, required: true, min: 0 },
    consumptionLpm: { type: Number, required: true, min: 0 }, // litres per minute
    validated: { type: Boolean, default: false },
    validatedBy: String,
    recordedBy: String,
    recordedAt: { type: Date, default: Date.now },
  }),
  'oxygenMeasurements',
);

const MedicalEquipment = model(
  'MedicalEquipment',
  new Schema(
    {
      assetTag: { type: String, required: true, unique: true, uppercase: true },
      name: { type: String, required: true },
      type: {
        type: String,
        enum: ['ventilator', 'bipap', 'monitor', 'defibrillator', 'infusion_pump', 'oxygen_concentrator', 'other'],
        required: true,
      },
      department: { type: ObjectId, ref: 'Department' },
      status: { type: String, enum: ['available', 'in_use', 'maintenance', 'out_of_service'], default: 'available' },
      assignedTo: { type: ObjectId, ref: 'Patient', default: null },
      lastMaintenance: Date,
      nextMaintenanceDue: Date,
      nextInspectionDue: Date,
    },
    { timestamps: true },
  ),
  'medicalEquipment',
);

const EquipmentMaintenance = model(
  'EquipmentMaintenance',
  new Schema({
    equipment: { type: ObjectId, ref: 'MedicalEquipment', required: true },
    kind: { type: String, enum: ['maintenance', 'inspection', 'repair', 'calibration'], required: true },
    status: { type: String, enum: ['open', 'completed'], default: 'completed' },
    notes: String,
    performedBy: String,
    performedAt: { type: Date, default: Date.now },
    nextDue: Date,
  }),
  'equipmentMaintenance',
);

const PurchaseOrder = model(
  'PurchaseOrder',
  new Schema(
    {
      poNumber: { type: String, required: true, unique: true },
      item: { type: ObjectId, ref: 'InventoryItem', required: true },
      quantity: { type: Number, required: true, min: 1 },
      supplier: String,
      status: { type: String, enum: ['draft', 'approved', 'ordered', 'received', 'cancelled'], default: 'draft' },
      expectedDate: Date,
      createdBy: String,
      notes: String,
    },
    { timestamps: true },
  ),
  'purchaseOrders',
);

const resourceAlertSchema = new Schema(
  {
    key: { type: String, required: true, unique: true }, // de-duplication key
    severity: { type: String, enum: ['critical', 'high', 'medium', 'low'], required: true },
    kind: { type: String, enum: ['confirmed', 'forecasted', 'maintenance', 'expiry', 'info'], required: true },
    category: String,
    title: { type: String, required: true },
    detail: String,
    metrics: Schema.Types.Mixed,
    status: { type: String, enum: ['open', 'acknowledged', 'resolved'], default: 'open' },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
const ResourceAlert = model('ResourceAlert', resourceAlertSchema, 'resourceAlerts');

const ResourceForecast = model(
  'ResourceForecast',
  new Schema({
    item: { type: ObjectId, ref: 'InventoryItem' },
    resourceName: String,
    category: String,
    unit: String,
    historyDays: Number,
    note: String,
    recommendedAction: String,
    horizonDays: Number,
    method: String,
    predictedDemand: Number,
    lower: Number,
    upper: Number,
    avgDaily: Number,
    available: Number,
    coverageDays: Number,
    expectedShortage: Boolean,
    insufficientData: Boolean,
    evaluation: { mae: Number, mape: Number, holdoutDays: Number },
    generatedAt: { type: Date, default: Date.now },
  }),
  'resourceForecasts',
);

const AuditLog = model(
  'AuditLog',
  new Schema({
    user: { type: ObjectId, ref: 'User' },
    userName: String,
    action: { type: String, required: true },
    entity: String,
    entityId: String,
    details: Schema.Types.Mixed,
    at: { type: Date, default: Date.now },
  }),
  'auditLogs',
);

module.exports = {
  ResourceCategory,
  InventoryItem,
  InventoryBatch,
  InventoryTransaction,
  OxygenCylinder,
  OxygenMeasurement,
  MedicalEquipment,
  EquipmentMaintenance,
  PurchaseOrder,
  ResourceAlert,
  ResourceForecast,
  AuditLog,
};
