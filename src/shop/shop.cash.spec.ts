import { jest } from '@jest/globals';
import { ShopService } from './shop.service';
import { PrismaService } from '../prisma/prisma.service';
import { todayIso, addMonths } from './shop.logic';

const shopId = 'shop-a';
const now = new Date();
const today = todayIso();

type CashTestCustomer = {
  id: string;
  customerNo: number;
  name: string;
  phone: string;
  photo: null;
  downPayment: number;
  initialMonthlyPayment: number;
  monthlyPayment: number;
  monthlyCollectionTarget: null;
  firstDueDate: string;
  createdAt: Date;
  rateChanges: never[];
  scheduleDateChanges: never[];
  items: { id: string; name: string; price: number; boughtOn: string }[];
  payments: {
    id: string;
    amount: number;
    paidOn: Date;
    createdAt: Date;
    method: string;
    note: null;
    reversedAt: Date | null;
  }[];
  purchases: never[];
  shopId: string;
  deletedAt: Date | null;
};

const makeCustomer = (
  firstDueDate: string,
  paymentAmount: number,
  paymentId = 'payment-a',
): CashTestCustomer => ({
  id: 'customer-a',
  customerNo: 1,
  name: 'Customer A',
  phone: '03001234567',
  photo: null,
  downPayment: 0,
  initialMonthlyPayment: 1000,
  monthlyPayment: 1000,
  monthlyCollectionTarget: null,
  firstDueDate,
  createdAt: new Date('2025-01-01T00:00:00Z'),
  rateChanges: [],
  scheduleDateChanges: [],
  items: [{ id: 'item-a', name: 'Item', price: 3000, boughtOn: firstDueDate }],
  payments: paymentAmount
    ? [
        {
          id: paymentId,
          amount: paymentAmount,
          paidOn: now,
          createdAt: now,
          method: 'Cash',
          note: null,
          reversedAt: null,
        },
      ]
    : [],
  purchases: [],
  shopId,
  deletedAt: null,
});

function serviceWith(customers: ReturnType<typeof makeCustomer>[]) {
  const prisma = {
    customer: {
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: { shopId: string; deletedAt: null };
        }) =>
          customers.filter(
            (customer) =>
              customer.shopId === where.shopId &&
              where.deletedAt === null &&
              customer.deletedAt === null,
          ),
      ),
    },
    payment: {
      findMany: jest.fn(
        async (query: {
          where: {
            customer: { shopId: string; deletedAt: null };
          };
        }) =>
          customers.flatMap((customer) =>
            customer.payments
              .filter(
                (payment) =>
                  !payment.reversedAt &&
                  query.where.customer.deletedAt === null &&
                  customer.deletedAt === null &&
                  customer.shopId === query.where.customer.shopId,
              )
              .map((payment) => ({
                ...payment,
                customer: { id: customer.id, name: customer.name },
              })),
          ),
      ),
    },
  } as unknown as PrismaService;

  return {
    service: new ShopService(
      prisma,
      {} as never,
      {} as never,
    ),
    prisma,
  };
}

describe('shop cash totals', () => {
  it('uses the same non-reversed cash total on the dashboard and collection endpoint', async () => {
    const customer = makeCustomer(addMonths(today, -2), 1000);
    const deletedCustomer = {
      ...makeCustomer(today, 9000, 'deleted-payment'),
      deletedAt: now,
    };
    const otherShopCustomer = {
      ...makeCustomer(today, 8000, 'other-shop-payment'),
      shopId: 'shop-b',
    };
    customer.payments.push({
      id: 'reversed-payment',
      amount: 800,
      paidOn: now,
      createdAt: now,
      method: 'Cash',
      note: null,
      reversedAt: now,
    });
    const { service, prisma } = serviceWith([
      customer,
      deletedCustomer,
      otherShopCustomer,
    ]);

    const dashboard = (await service.dashboard(shopId)).data;
    const collection = (await service.collectionToday(shopId)).data;
    const payments = (await service.paymentsToday(shopId)).data;

    expect(dashboard.cashToday.total).toBe(1000);
    expect(collection.cashToday.total).toBe(dashboard.cashToday.total);
    expect(payments.reduce((sum, payment) => sum + payment.amount, 0)).toBe(
      dashboard.cashToday.total,
    );
    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          reversedAt: null,
          customer: expect.objectContaining({ shopId, deletedAt: null }),
        }),
      }),
    );
    expect(prisma.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId, deletedAt: null },
      }),
    );
  });

  it('counts cash paid today against overdue installments before today due installments', async () => {
    const { service } = serviceWith([makeCustomer(addMonths(today, -2), 1000)]);

    const dashboard = (await service.dashboard(shopId)).data;

    expect(dashboard.cashToday).toMatchObject({
      total: 1000,
      forPeriod: 0,
      late: 1000,
      advance: 0,
    });
    expect(dashboard.todayInstallments).toEqual({
      total: 1000,
      paid: 0,
      remaining: 1000,
    });
  });

  it('splits cash that clears late installments and reaches today due installment', async () => {
    const { service } = serviceWith([
      makeCustomer(addMonths(today, -2), 2500),
    ]);

    const dashboard = (await service.dashboard(shopId)).data;

    expect(dashboard.cashToday).toMatchObject({
      total: 2500,
      forPeriod: 500,
      late: 2000,
      advance: 0,
    });
    expect(dashboard.todayInstallments).toEqual({
      total: 1000,
      paid: 500,
      remaining: 500,
    });
  });

  it('classifies a payment allocated to a future due installment as advance cash', async () => {
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000)
      .toISOString()
      .slice(0, 10);
    const customer = makeCustomer(tomorrow, 1000);
    customer.items[0].price = 1000;
    const { service } = serviceWith([customer]);

    const dashboard = (await service.dashboard(shopId)).data;

    expect(dashboard.cashToday).toMatchObject({
      total: 1000,
      forPeriod: 0,
      late: 0,
      advance: 1000,
    });
  });

  it('includes completed customer payment history in cash totals', async () => {
    const { service } = serviceWith([
      makeCustomer(addMonths(today, -2), 3000, 'completed-customer-payment'),
    ]);

    const dashboard = (await service.dashboard(shopId)).data;

    expect(dashboard.cashToday).toMatchObject({
      total: 3000,
      forPeriod: 1000,
      late: 2000,
      advance: 0,
    });
  });

  it('reports overall late balance separately from this-month overdue installments', async () => {
    const firstDueDate = addMonths(`${today.slice(0, 7)}-01`, -1);
    const { service } = serviceWith([makeCustomer(firstDueDate, 0)]);

    const result = await service.late(shopId);
    const lateCustomers = result.data;

    expect(lateCustomers).toHaveLength(1);
    expect(lateCustomers[0]).toMatchObject({
      lateAmount: 2000,
      lateThisMonthAmount: 1000,
      lateCount: 2,
    });
  });

  it('separates late installments from ordinary balance in monthly report customer rows', async () => {
    const firstDueDate = addMonths(`${today.slice(0, 7)}-01`, -1);
    const { service } = serviceWith([makeCustomer(firstDueDate, 0)]);

    const result = await service.status(shopId, today.slice(0, 7));
    const report = result.data;
    const customer = report.customers[0];

    expect(report.expected).toBe(
      report.received +
        Math.max(0, report.remaining - report.overdue) +
        report.overdue,
    );
    expect(customer).toMatchObject({
      expected: 1000,
      received: 0,
      remaining: 1000,
      overdue: 1000,
      paidInstallments: 0,
      pendingInstallments: 1,
      lateInstallments: 1,
      lateInstallmentDates: [`${today.slice(0, 7)}-01`],
    });
  });

  it('includes the due date for a paid installment in the monthly report', async () => {
    const dueDate = `${today.slice(0, 7)}-01`;
    const { service } = serviceWith([makeCustomer(dueDate, 1000)]);

    const result = await service.status(shopId, today.slice(0, 7));

    expect(result.data.customers[0].paidInstallmentDates).toEqual([dueDate]);
  });
});
