// Patient-flow and core operations collections.
const mongoose = require('mongoose');
const { Schema, model } = mongoose;
const { ROLES } = require('../middleware/auth');

const User = model(
  'User',
  new Schema(
    {
      name: { type: String, required: true, trim: true },
      email: { type: String, required: true, unique: true, lowercase: true, trim: true },
      passwordHash: { type: String, required: true },
      role: { type: String, enum: ROLES, default: 'receptionist' },
      active: { type: Boolean, default: true },
    },
    { timestamps: true },
  ),
);

const Department = model(
  'Department',
  new Schema({
    name: { type: String, required: true, unique: true },
    code: { type: String, required: true, unique: true, uppercase: true },
    avgServiceMinutes: { type: Number, default: 20, min: 1 },
  }),
);

const Bed = model(
  'Bed',
  new Schema(
    {
      label: { type: String, required: true, unique: true },
      department: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
      bedType: { type: String, enum: ['general', 'icu', 'isolation', 'pediatric'], default: 'general' },
      status: { type: String, enum: ['available', 'occupied', 'cleaning', 'maintenance'], default: 'available' },
    },
    { timestamps: true },
  ),
);

const Staff = model(
  'Staff',
  new Schema({
    fullName: { type: String, required: true },
    role: { type: String, enum: ['doctor', 'nurse', 'technician', 'support'], required: true },
    department: { type: Schema.Types.ObjectId, ref: 'Department' },
    shift: { type: String, enum: ['day', 'evening', 'night'], default: 'day' },
    onDuty: { type: Boolean, default: true },
  }),
);

const Patient = model(
  'Patient',
  new Schema(
    {
      fullName: { type: String, required: true },
      age: { type: Number, min: 0, max: 130, default: 0 },
      complaint: { type: String, default: '' },
      department: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
      priority: { type: String, enum: ['critical', 'urgent', 'normal', 'low'], default: 'normal' },
      status: { type: String, enum: ['waiting', 'in_consultation', 'admitted', 'discharged'], default: 'waiting' },
      bed: { type: Schema.Types.ObjectId, ref: 'Bed', default: null },
      arrivedAt: { type: Date, default: Date.now },
      dischargedAt: Date,
    },
    { timestamps: true },
  ),
);

const arrivalSchema = new Schema({
  department: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
  hourStart: { type: Date, required: true },
  arrivals: { type: Number, default: 0, min: 0 },
});
arrivalSchema.index({ department: 1, hourStart: 1 }, { unique: true });
const ArrivalHistory = model('ArrivalHistory', arrivalSchema);

module.exports = { User, Department, Bed, Staff, Patient, ArrivalHistory };
