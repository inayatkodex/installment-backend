import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { MobileShopLoginDto } from './dto/mobile-shop-login.dto';
import { RefreshShopSessionDto } from './dto/refresh-shop-session.dto';
import { ShopLoginDto } from './dto/shop-login.dto';
import { ShopSignupDto } from './dto/shop-signup.dto';

@ApiTags('Auth')
@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('shop-auth/signup')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Shopkeeper registration (status pending se shuru hota hai)',
  })
  @ApiCreatedResponse({
    description: 'Registration ho gayi, admin approve karega',
  })
  @ApiBadRequestResponse({ description: 'Data sahi nahi hai' })
  @ApiConflictResponse({
    description: 'Yeh mobile number pehle se registered hai',
  })
  shopSignup(@Body() dto: ShopSignupDto) {
    return this.auth.shopSignup(dto);
  }

  @Post('shop-auth/login')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Shopkeeper login (sirf active shop login kar sakti hai)',
  })
  @ApiOkResponse({ description: 'access_token aur user milta hai' })
  @ApiUnauthorizedResponse({
    description: 'Mobile number ya password sahi nahi hai',
  })
  @ApiForbiddenResponse({
    description: 'Shop pending, inactive ya archived hai',
  })
  shopLogin(@Body() dto: ShopLoginDto) {
    return this.auth.shopLogin(dto);
  }

  @Post('shop-auth/mobile-login')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Shopkeeper mobile login with refresh session' })
  @ApiOkResponse({
    description: 'Returns a short-lived access token and refresh token',
  })
  @ApiUnauthorizedResponse({
    description: 'Mobile number ya password sahi nahi hai',
  })
  @ApiForbiddenResponse({
    description: 'Shop pending, inactive ya archived hai',
  })
  mobileShopLogin(@Body() dto: MobileShopLoginDto) {
    return this.auth.mobileShopLogin(dto);
  }

  @Post('shop-auth/refresh')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate a mobile shop refresh token' })
  @ApiOkResponse({ description: 'Returns a new access and refresh token pair' })
  @ApiUnauthorizedResponse({
    description: 'Mobile session invalid ya expire ho gaya',
  })
  refreshShopSession(@Body() dto: RefreshShopSessionDto) {
    return this.auth.refreshShopSession(dto.refreshToken);
  }

  @Post('shop-auth/logout')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a mobile shop session' })
  @ApiOkResponse({ description: 'Mobile session logged out' })
  logoutShopSession(@Body() dto: RefreshShopSessionDto) {
    return this.auth.logoutShopSession(dto.refreshToken);
  }

  @Post('admin-auth/login')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin login' })
  @ApiOkResponse({ description: 'Returns access_token and user' })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password' })
  adminLogin(@Body() dto: AdminLoginDto) {
    return this.auth.adminLogin(dto);
  }
}
