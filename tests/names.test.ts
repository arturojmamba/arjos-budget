import { test } from 'node:test';
import assert from 'node:assert/strict';
import { niceName } from '../web/format.ts';

test('bank descriptions in capitals read in normal case, acronyms kept', () => {
  assert.equal(niceName('CITY TRANSIT TRAVEL CHARGE'), 'City Transit Travel Charge');
  assert.equal(niceName('TFL TRAVEL CH'), 'TfL Travel CH');
  assert.equal(niceName('HMRC PAYE'), 'HMRC PAYE');
  assert.equal(niceName('NORTHWIND LTD SALARY'), 'Northwind Ltd Salary');
  assert.equal(niceName('MCDONALDS 1234'), "McDonald's 1234");
  assert.equal(niceName('EE LIMITED'), 'EE Limited');
  assert.equal(niceName('Corner Cafe'), 'Corner Cafe');
  assert.equal(niceName(''), '');
});
