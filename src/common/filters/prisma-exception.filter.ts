import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { Response } from 'express';

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    this.logger.error(`Prisma error ${exception.code}: ${exception.message}`);

    let status = HttpStatus.BAD_REQUEST;
    let message = 'Database error occurred';

    switch (exception.code) {
      case 'P2002': {
        status = HttpStatus.CONFLICT;
        const target = (exception.meta?.target as string[])?.join(', ');
        message = target
          ? `Yeh record pehle se maujood hai (${target})`
          : 'Yeh record pehle se maujood hai';
        break;
      }
      case 'P2003': {
        status = HttpStatus.BAD_REQUEST;
        message = 'Rabta qayam nahi ho saka (Foreign key issue)';
        break;
      }
      case 'P2025': {
        status = HttpStatus.NOT_FOUND;
        message = 'Record nahi mila';
        break;
      }
      default: {
        status = HttpStatus.BAD_REQUEST;
        message = 'Data process nahi ho saka';
        break;
      }
    }

    response.status(status).json({
      statusCode: status,
      message,
      status: 'error',
    });
  }
}
